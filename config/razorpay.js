import Razorpay from 'razorpay'
import crypto from 'crypto'

// ── Startup validation ──────────────────────────────────────────
// Catches missing/empty env vars immediately instead of failing later with a vague 401
const KEY_ID = process.env.RAZORPAY_KEY_ID?.trim()
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET?.trim()

if (!KEY_ID || !KEY_SECRET) {
  console.error('❌ Razorpay keys missing! RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is not set in env.')
} else {
  const mode = KEY_ID.startsWith('rzp_live_') ? 'LIVE' : KEY_ID.startsWith('rzp_test_') ? 'TEST' : 'UNKNOWN'
  console.log(`✅ Razorpay initialized — mode: ${mode}, key_id: ${KEY_ID.slice(0, 12)}..., secret length: ${KEY_SECRET.length}`)
}

export const razorpay = new Razorpay({
  key_id: KEY_ID,
  key_secret: KEY_SECRET,
})

export const createRazorpayOrder = async ({ orderId, amountPaise, notes = {} }) => {
  try {
    return await razorpay.orders.create({
      amount: amountPaise,   // Razorpay also expects paise, so no conversion needed
      currency: 'INR',
      receipt: orderId,
      notes,
    })
  } catch (err) {
    // Razorpay SDK errors carry useful detail in err.error — log it fully instead of swallowing it
    console.error('❌ Razorpay order creation failed:', {
      statusCode: err.statusCode,
      error: err.error,
    })
    throw err
  }
}

// Verifies the signature returned by Razorpay Checkout after a successful payment
export const verifyRazorpaySignature = ({ orderId, paymentId, signature }) => {
  const expected = crypto
    .createHmac('sha256', KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex')
  return expected === signature
}

// Verifies the webhook payload signature (X-Razorpay-Signature header)
export const verifyWebhookSignature = (rawBody, signature) => {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    console.error('❌ RAZORPAY_WEBHOOK_SECRET is not set in env.')
    return false
  }
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex')
  return expected === signature
}