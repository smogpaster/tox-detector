import { z } from 'zod'
import { PATTERNS } from '@spiegel/shared'

export const FindingSchema = z.object({
  speaker: z.string().describe('Sprecherlabel der Äußerung, z. B. "A"'),
  pattern: z.enum(PATTERNS),
  utteranceId: z.string().describe('ID der Äußerung, z. B. "u12"'),
  quote: z.string().describe('Wörtliches Zitat aus genau dieser Äußerung, maximal ein Satz'),
  intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]).describe('1 leicht, 2 deutlich, 3 stark'),
  reactsTo: z
    .object({
      utteranceId: z.string(),
      description: z.string().describe('Worauf reagiert die Äußerung und wie, neutral formuliert'),
    })
    .nullable(),
  evidence: z.string().describe('Kurze neutrale Begründung, warum das Muster hier vorliegt'),
})

export const WindowAnalysisSchema = z.object({
  findings: z.array(FindingSchema),
  climate: z.string().describe('Ein neutraler Satz zur Dynamik in diesem Abschnitt'),
  tension: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).describe('0 ruhig, 1 leicht angespannt, 2 angespannt, 3 stark angespannt'),
})
export type WindowAnalysisOutput = z.infer<typeof WindowAnalysisSchema>

export const ReportSchema = z.object({
  summary: z.string().describe('3 bis 5 wertschätzende Sätze zur Gesamtdynamik, ohne Schuldzuweisung'),
  perSpeaker: z.array(
    z.object({
      speaker: z.string(),
      strengths: z.array(z.string()).describe('Was dieser Person im Gespräch gut gelungen ist'),
      patternsToWatch: z.array(z.string()).describe('Muster, auf die diese Person achten könnte, konkret und freundlich'),
    }),
  ),
  dynamics: z.array(
    z.object({
      name: z.string().describe('Name der Wechselwirkung, z. B. "Vorwurf → Rechtfertigung"'),
      description: z.string(),
      example: z.object({ triggerUtteranceId: z.string(), responseUtteranceId: z.string() }).nullable(),
    }),
  ),
  turningPoints: z.array(z.object({ utteranceId: z.string(), description: z.string() })),
  positiveMoments: z.array(z.object({ utteranceId: z.string(), description: z.string() })),
  suggestions: z.array(
    z.object({
      forWhom: z.string().describe('"beide" oder ein Sprecherlabel'),
      suggestion: z.string().describe('Ein konkreter, umsetzbarer Vorschlag'),
      why: z.string().describe('Bezug zu einer beobachteten Stelle im Gespräch'),
    }),
  ),
})
export type ReportOutput = z.infer<typeof ReportSchema>
