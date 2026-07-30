import axios from 'axios'

const CF_BASE = process.env.CASHFREE_ENV === 'production'
  ? 'https://api.cashfree.com/pg'
  : 'https://sandbox.cashfree.com/pg'

const headers = {
  'x-client-id': process.env.CASHFREE_APP_ID,
  'x-client-secret': process.env.CASHFREE_SECRET_KEY,
  'x-api-version': '2023-08-01',
  'Content-Type': 'application/json',
}

// Creates a Cashfree order, returns payment_session_id (frontend uses this to open checkout)
export const createCashfreeOrder = async ({ orderId, amountPaise, customerId, customerPhone, returnUrl }) => {
  const res = await axios.post(`${CF_BASE}/orders`, {
    order_id: orderId,
    order_amount: amountPaise / 100, // Cashfree expects rupees, not paise
    order_currency: 'INR',
    customer_details: {
      customer_id: customerId,
      customer_phone: customerPhone || '9999999999',
    },
    order_meta: {
      return_url: returnUrl,
    },
  }, { headers })
  return res.data // contains payment_session_id, order_id, order_status
}

// Checks order status (used in verify step)
export const checkCashfreeStatus = async (orderId) => {
  const res = await axios.get(`${CF_BASE}/orders/${orderId}`, { headers })
  return res.data // contains order_status: 'PAID' | 'ACTIVE' | 'EXPIRED' etc.
}