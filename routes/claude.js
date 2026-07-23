import express from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'

const router = express.Router()
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// existing Claude route
router.post('/chat', async (req, res) => {
  // ... your existing code unchanged
})

// NEW Gemini route
router.post('/gemini', async (req, res) => {
  try {
    const { messages, system } = req.body
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' })
    }
    const model = genAI.getGenerativeModel({
     model: "gemini-1.5-flash" ,
      systemInstruction: system || 'You are a helpful assistant for Zater Web Studio.',
    })
    const history = messages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))
    const chat = model.startChat({ history })
    const lastMsg = messages[messages.length - 1].content
    const result = await chat.sendMessage(lastMsg)
    res.json({ content: result.response.text(), usage: null })
  } catch (err) {
    console.error('Gemini API error:', err)
    res.status(500).json({ error: err.message })
  }
})

export default router