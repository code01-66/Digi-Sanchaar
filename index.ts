import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { z } from 'zod';
import { Twilio } from 'twilio';
import { Resend } from 'resend';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());
app.use(cors());

// --- Zod Schema for validation ---
const EmergencyContactSchema = z.object({
  name: z.string(),
  phone: z.string(),
  email: z.string(),
});

const SosRequestSchema = z.object({
  emergencyContacts: z.array(EmergencyContactSchema),
  location: z.object({
    lat: z.number(),
    lng: z.number(),
  }),
  audioAnalysis: z.object({
    summary: z.string(),
    keywords: z.array(z.string()),
  }),
  user: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
  }),
});

// --- API Endpoint ---
app.post('/api/trigger-sos', async (req, res) => {
  console.log('Received SOS request...');

  // 1. Validate the incoming data
  const validation = SosRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.error('Invalid request body:', validation.error.flatten());
    return res.status(400).json({
      status: 'Error',
      message: 'Invalid request body.',
      errors: validation.error.flatten(),
    });
  }

  const { emergencyContacts, location, audioAnalysis, user } = validation.data;
  console.log(`SOS for user: ${user.name || 'N/A'}`);
  console.log(`Notifying ${emergencyContacts.length} contacts.`);

  // 2. Check for API Keys
  const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER,
    RESEND_API_KEY,
  } = process.env;

  if (
    !TWILIO_ACCOUNT_SID ||
    !TWILIO_AUTH_TOKEN ||
    !TWILIO_PHONE_NUMBER ||
    !RESEND_API_KEY
  ) {
    const errorMsg =
      'Server is not configured for notifications. Missing API keys.';
    console.error(errorMsg);
    return res.status(500).json({ status: 'Error', message: errorMsg });
  }

  const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  const resendClient = new Resend(RESEND_API_KEY);

  // 3. Send Notifications
  let emailsSent = 0;
  let callsMade = 0;
  const googleMapsUrl = `https://www.google.com/maps?q=${location.lat},${location.lng}`;
  const userName = user.name || 'A DigiSanchaar user';

  for (const contact of emergencyContacts) {
    // Send Email via Resend
    try {
      await resendClient.emails.send({
        from: 'DigiSanchaar Alert <onboarding@resend.dev>',
        to: contact.email,
        subject: `URGENT: SOS Alert from ${userName}`,
        html: `
          <p>This is an automated SOS alert from the DigiSanchaar app.</p>
          <p><strong>${userName} has triggered an emergency alert.</strong></p>
          <p><strong>Last Known Location:</strong> <a href="${googleMapsUrl}">${googleMapsUrl}</a></p>
          <p><strong>AI Summary of Situation:</strong> ${audioAnalysis.summary}</p>
          <p>Please attempt to contact them or the authorities immediately.</p>
        `,
      });
      emailsSent++;
      console.log(`Email sent to ${contact.email}`);
    } catch (error) {
      console.error(`Failed to send email to ${contact.email}:`, error);
    }

    // Make Call via Twilio
    try {
      await twilioClient.calls.create({
        twiml: `<Response><Say>This is an urgent automated alert from DigiSanchaar. ${userName} has triggered an S O S. Their last known location is available via email. Please check your email and contact them or the authorities immediately.</Say></Response>`,
        to: contact.phone,
        from: TWILIO_PHONE_NUMBER,
      });
      callsMade++;
      console.log(`Call made to ${contact.phone}`);
    } catch (error) {
      console.error(`Failed to make call to ${contact.phone}:`, error);
    }
  }

  const responseMessage = `SOS processed. Emailed ${emailsSent} contacts. Called ${callsMade} contacts.`;
  console.log(responseMessage);
  res.status(200).json({
    status: 'Success',
    message: responseMessage,
  });
});

app.get('/', (req, res) => {
    res.status(200).send('DigiSanchaar SOS Backend is running.');
});


app.listen(port, () => {
  console.log(`SOS Backend server listening on port ${port}`);
});
