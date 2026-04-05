const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

/**
 * Solve a CAPTCHA image using Google Gemini API.
 * Gemini is much more resilient to noise lines than Tesseract.
 */
async function solveCaptcha(imageBuffer) {
  // Save raw for debugging
  fs.writeFileSync('captcha-raw.png', imageBuffer);

  // Get API key from environment
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log('  ⚠ GEMINI_API_KEY is not set in .env! Cannot solve CAPTCHA.');
    return '';
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);

    // Use gemini-1.5-flash for speed and vision capabilities
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

    // Prepare the image part for Gemini
    const imageParts = [
      {
        inlineData: {
          data: imageBuffer.toString("base64"),
          mimeType: "image/png"
        }
      }
    ];

    const prompt = "This is a CAPTCHA image containing exactly 5 uppercase letters and/or numbers. Respond ONLY with the 5 characters you see. Do not include spaces, quotes, or any other text.";

    console.log(`  Sending CAPTCHA to Gemini API...`);
    const result = await model.generateContent([prompt, ...imageParts]);
    const response = await result.response;
    const text = response.text();

    // Clean up the response
    const cleaned = text.replace(/[^A-Z0-9]/g, '').toUpperCase().trim();

    console.log(`  ➤ Gemini OCR Result: "${cleaned}"`);
    return cleaned;
  } catch (err) {
    console.log(`  [Gemini API] Error: ${err.message}`);
    return '';
  }
}

module.exports = { solveCaptcha };
