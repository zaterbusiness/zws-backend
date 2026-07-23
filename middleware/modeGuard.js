// middleware/modeGuard.js
import { detectPromptType } from '../utils/intentGuard.js'

/**
 * Blocks generation if the prompt clearly belongs to the other section.
 * expectedType: 'website' | 'app'
 */
export function modeGuard(expectedType) {
  return (req, res, next) => {
    const prompt = req.body?.prompt
    if (!prompt?.trim()) return next() // let downstream validation handle empty prompt

    const detected = detectPromptType(prompt)
    const opposite = expectedType === 'website' ? 'app' : 'website'

    if (detected === opposite) {
      return res.status(400).json({
        error: 'MODE_MISMATCH',
        message: expectedType === 'website'
          ? 'This looks like a full-stack app request, not a website. Please switch to the Full-Stack App section to generate it.'
          : 'This looks like a website request, not a full-stack app. Please switch to the Website section to generate it.',
        suggestedMode: opposite,
      })
    }

    next()
  }
}