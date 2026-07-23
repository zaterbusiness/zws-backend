import crypto from 'crypto'
import axios from 'axios'

const MERCHANT_ID   = process.env.PHONEPE_MERCHANT_ID
const SALT_KEY       = process.env.PHONEPE_SALT_KEY
const SALT_INDEX     = process.env.PHONEPE_SALT_INDEX || '1'
const IS_PROD         = process.env.PHONEPE_ENV === 'production'

const BASE_URL = IS_PROD
  ? 'https://api.phonepe.com/apis/hermes'
  : 'https://api-preprod.phonepe.com/apis/pg-sandbox'

const sha256 = (str) => crypto.createHash('sha256').update(str).digest('hex')

// Builds X-VERIFY header for any endpoint + payload combo
const buildChecksum = (base64Payload, endpointPath) => {
  const hash = sha256(base64Payload + endpointPath + SALT_KEY)
  return `${hash}###${SALT_INDEX}`
}

// ── Initiate a payment — returns { redirectUrl, merchantTransactionId } ──
export const initiatePhonePePayment = async ({ amountPaise, merchantUserId, merchantTransactionId, redirectUrl, callbackUrl }) => {
  const payload = {
    merchantId: MERCHANT_ID,
    merchantTransactionId,
    merchantUserId,
    amount: amountPaise, // PhonePe also expects paise
    redirectUrl,
    redirectMode: 'REDIRECT',
    callbackUrl,
    paymentInstrument: { type: 'PAY_PAGE' },
  }

  const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64')
  const xVerify = buildChecksum(base64Payload, '/pg/v1/pay')

  const { data } = await axios.post(
    `${BASE_URL}/pg/v1/pay`,
    { request: base64Payload },
    { headers: { 'Content-Type': 'application/json', 'X-VERIFY': xVerify, accept: 'application/json' } }
  )

  if (!data?.success) throw new Error(data?.message || 'PhonePe order creation failed')

  return {
    redirectUrl: data.data.instrumentResponse.redirectInfo.url,
    merchantTransactionId,
  }
}

// ── Check status of a transaction — call this to "verify" payment ──
export const checkPhonePeStatus = async (merchantTransactionId) => {
  const path = `/pg/v1/status/${MERCHANT_ID}/${merchantTransactionId}`
  const xVerify = buildChecksum('', path) // status API checksum has no payload, just path+salt

  const { data } = await axios.get(`${BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      'X-VERIFY': xVerify,
      'X-MERCHANT-ID': MERCHANT_ID,
      accept: 'application/json',
    },
  })

  return data // data.code === 'PAYMENT_SUCCESS' when paid
}