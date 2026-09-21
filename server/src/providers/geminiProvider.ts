import { GoogleGenAI } from '@google/genai';
import { AiError, type GenerateImage } from '../services/aiService.js';

/** Only this adapter knows the Gemini Interactions API. Official guide checked 2026-09-21. */
export function geminiProvider(apiKey: string, model: string): GenerateImage {
  const ai = new GoogleGenAI({ apiKey });
  return async (prompt, ratio, signal) => {
    const interaction = await ai.interactions.create({
      model, input: prompt, store: false,
      response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: ratio, image_size: '1K', delivery: 'inline' },
    }, { signal, retries: { strategy: 'none' } });
    if (interaction.status === 'failed') throw new AiError('PROVIDER_REFUSAL', 'The image service could not create this artwork. Try a different visual description.');
    const image = interaction.output_image;
    if (!image?.data) throw new AiError('NO_IMAGE', 'The image service returned no artwork. Try a different visual description.');
    return { data: image.data, mimeType: image.mime_type ?? '' };
  };
}
