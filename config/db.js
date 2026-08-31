import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
dotenv.config()

// Aiven requires SSL. If you have the CA cert file, use it (more secure).
// Otherwise, fall back to rejectUnauthorized:false (works, but skips cert verification).
const sslConfig = process.env.DB_SSL_CA
  ? { ca: process.env.DB_SSL_CA.replace(/\\n/g, '\n') }
  : { rejectUnauthorized: false }

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               Number(process.env.DB_PORT) || 3306,
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASSWORD || '',
  database:           process.env.DB_NAME     || 'zater_ai',
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  charset:            'utf8mb4',
  ssl:                sslConfig,
  enableKeepAlive:       true,
  keepAliveInitialDelay: 10000,
})

export const testConnection = async () => {
  try {
    const conn = await pool.getConnection()
    console.log('✅ MySQL connected —', process.env.DB_NAME)
    conn.release()
    return true
  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message)
    return false
  }
}

export const query = async (sql, params = [], retrying = false) => {
  try {
    const [rows] = await pool.execute(sql, params)
    return rows
  } catch (err) {
    if (err.code === 'ECONNRESET' && !retrying) {
      console.warn('⚠️ ECONNRESET — retrying query once:', sql)
      return query(sql, params, true)
    }
    console.error('DB Error:', err.message, '\nSQL:', sql)
    throw err
  }
}

export const queryOne = async (sql, params = []) => {
  const rows = await query(sql, params)
  return rows[0] || null
}

export default pool