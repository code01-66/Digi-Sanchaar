
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { z } from 'zod';
import { Twilio } from 'twilio';
import { Resend } from 'resend';
import webpush from 'web-push';
import { getFirestore } from 'firebase-admin/firestore';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { geohashQueryBounds, distanceBetween } from 'geofire-common';

dotenv.config();

// --- Firebase Admin SDK Initialization ---
let db: import('firebase-admin/firestore').Firestore;
let firebaseInitialized = false;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    if (!getApps().length) {
      initializeApp({
        credential: cert(serviceAccount),
      });
      console.log('Firebase Admin SDK initialized.');
    }
    db = getFirestore();
    firebaseInitialized = true;
  } else {
    console.error('FIREBASE_SERVICE_ACCOUNT_KEY is not set. Firebase features will be disabled.');
  }
} catch (e: any) {
  console.error('Firebase Admin SDK initialization failed.', e.message);
  console.warn("Nearby SOS push notifications will be disabled due to initialization failure.");
}


const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());
app.use(cors());

// --- VAPID Keys for Web Push ---
const publicVapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;

if (publicVapidKey && privateVapidKey) {
  webpush.setVapidDetails(
    'mailto:your-email@example.com', // Replace with your email
    publicVapidKey,
    privateVapidKey
  );
  console.log('VAPID keys configured for web-push.');
} else {
  console.warn('VAPID keys are not set. Push notifications will be disabled.');
}


// --- Zod Schemas for validation ---
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
    uid: z.string(),
  }),
});

const PushSubscriptionSchema = z.object({
    endpoint: z.string().url(),
    keys: z.object({
        p256dh: z.string(),
        auth: z.string(),
    }),
});


// --- Helper function to format phone numbers ---
const formatPhoneNumber = (phone: string) => {
    if (phone.trim().startsWith('+')) {
        return phone.trim();
    }
    const cleaned = phone.replace(/\D/g, '');
    return `+91${cleaned}`;
};


// --- API Endpoints ---

app.post('/api/save-subscription', async (req, res) => {
    if (!firebaseInitialized) {
        return res.status(503).json({ status: 'Error', message: 'Service unavailable: Firebase not configured.' });
    }
    
    const subscriptionValidation = PushSubscriptionSchema.safeParse(req.body.subscription);
    const userId = req.body.userId; // Expecting userId in the body

    if (!subscriptionValidation.success || !userId) {
        console.error('Invalid push subscription or missing userId:', subscriptionValidation.error);
        return res.status(400).json({ status: 'Error', message: 'Invalid subscription object or missing user ID.' });
    }

    const subscription = subscriptionValidation.data;

    try {
        const userDocRef = db.collection('users').doc(userId);
        await userDocRef.set({ pushSubscription: subscription }, { merge: true });
        console.log(`Saved push subscription for user: ${userId}`);

        // Send a confirmation push notification
        const payload = JSON.stringify({ title: 'DigiSanchaar', body: 'You are now subscribed to community alerts!' });
        if (publicVapidKey && privateVapidKey) {
            await webpush.sendNotification(subscription, payload);
        }
        res.status(201).json({ status: 'Success', message: 'Subscription saved and confirmation sent.' });
    } catch (error) {
        console.error('Error saving subscription to Firestore or sending push:', error);
        res.status(500).json({ status: 'Error', message: 'Failed to save subscription or send confirmation.' });
    }
});


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
  console.log(`SOS for user: ${user.name || 'N/A'} at lat: ${location.lat}, lng: ${location.lng}`);
  
  // --- Notify Nearby Users (Push Notifications) ---
  let nearbyUsersNotified = 0;
  if (firebaseInitialized && publicVapidKey && privateVapidKey) {
    try {
        console.log('Finding nearby users...');
        const center: [number, number] = [location.lat, location.lng];
        const radiusInM = 5 * 1000; // 5km radius

        const bounds = geohashQueryBounds(center, radiusInM);
        const promises = [];
        for (const b of bounds) {
            const q = db.collection('users')
                .orderBy('lastLocation.geohash')
                .startAt(b[0])
                .endAt(b[1]);
            promises.push(q.get());
        }

        const snapshots = await Promise.all(promises);
        const matchingDocs: any[] = [];
        for (const snap of snapshots) {
            for (const doc of snap.docs) {
                const docData = doc.data();
                // Exclude the user who triggered the SOS
                if (doc.id === user.uid) continue;
                
                const lat = docData.lastLocation?.lat;
                const lng = docData.lastLocation?.lng;

                if (lat && lng) {
                    const distanceInKm = distanceBetween([lat, lng], center);
                    const distanceInM = distanceInKm * 1000;
                    if (distanceInM <= radiusInM) {
                        matchingDocs.push(docData);
                    }
                }
            }
        }

        console.log(`Found ${matchingDocs.length} potential users nearby.`);
        
        const notificationPayload = JSON.stringify({
            title: 'NEARBY SOS ALERT',
            body: 'A DigiSanchaar user near you has triggered an SOS. Tap to view details.',
            url: '/community-alert', // The URL to open on click
            icon: '/icon-192x192.png'
        });

        const pushPromises = matchingDocs.map(nearbyUser => {
            if (nearbyUser.pushSubscription) {
                return webpush.sendNotification(nearbyUser.pushSubscription, notificationPayload)
                    .then(() => {
                        nearbyUsersNotified++;
                    })
                    .catch(err => {
                        console.log(`Failed to send notification to a user. Subscription might be expired. Error: ${err.message}`);
                        // TODO: In a real app, you might want to remove expired subscriptions from the database.
                    });
            }
            return Promise.resolve();
        });

        await Promise.all(pushPromises);
        console.log(`Successfully sent push notifications to ${nearbyUsersNotified} nearby users.`);
    } catch(e) {
        console.error("Failed to query or notify nearby users:", e);
    }
  }


  // --- Notify Emergency Contacts (Email & Call) ---
  console.log(`Notifying ${emergencyContacts.length} emergency contacts.`);
  const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER,
    RESEND_API_KEY,
    RESEND_FROM_EMAIL,
  } = process.env;

  const areApiKeysMissing = !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !RESEND_API_KEY || !RESEND_FROM_EMAIL;

  if (areApiKeysMissing) {
    const errorMsg = 'Server is not configured for email/call notifications. One or more API keys are missing in environment variables (Twilio SID, Auth Token, Phone Number, Resend API Key, or Resend From Email).';
    console.error(errorMsg);
    // Don't return here, but include this in the final response message.
  } else {
     const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
     const resendClient = new Resend(RESEND_API_KEY);
     
     const googleMapsUrl = `https://www.google.com/maps?q=${location.lat},${location.lng}`;
     const userName = user.name || 'A DigiSanchaar user';
     const situationSummary = audioAnalysis.summary || 'The user has triggered an SOS alert.';

     const callMessage = `Urgent alert from DigiSanchaar. ${userName} has triggered an SOS. Situation summary: ${situationSummary}. Location is available via email.`;
     const emailBody = `
        <h1>Urgent SOS Alert from ${userName}</h1>
        <p>This is an automated SOS alert from the DigiSanchaar application.</p>
        <p><b>User:</b> ${userName}</p>
        <p><b>AI Situation Summary:</b> ${situationSummary}</p>
        <p><b>Keywords Detected:</b> ${audioAnalysis.keywords.join(', ') || 'None'}</p>
        <p><b>Last Known Location:</b></p>
        <p><a href="${googleMapsUrl}" target="_blank">Click here to view on Google Maps</a></p>
        <p>Coordinates: ${location.lat}, ${location.lng}</p>
        <br/>
        <p>Please take appropriate action and contact authorities if necessary.</p>
     `;

      for (const contact of emergencyContacts) {
        // Send Email
        try {
            await resendClient.emails.send({
                from: RESEND_FROM_EMAIL!,
                to: contact.email,
                subject: `URGENT: SOS Alert from ${userName}`,
                html: emailBody,
            });
            console.log(`Successfully sent email to ${contact.email}`);
        } catch (error: any) {
            console.error(`Failed to send email to ${contact.email}. Error: ${error.message}`);
        }

        // Make Call
        try {
            await twilioClient.calls.create({
                twiml: `<Response><Say>${callMessage}</Say></Response>`,
                to: formatPhoneNumber(contact.phone),
                from: `+${TWILIO_PHONE_NUMBER!.replace(/\D/g, '')}`,
            });
             console.log(`Successfully initiated call to ${contact.phone}`);
        } catch (error: any) {
            console.error(`Failed to make call to ${contact.phone}. Error: ${error.message}`);
        }
      }
  }
  
  let responseMessage = `SOS processed. Notified ${nearbyUsersNotified} nearby users via push.`;
  if (areApiKeysMissing) {
    responseMessage += " Emergency contact notifications were skipped due to missing server configuration.";
  } else {
    responseMessage += " Emergency contact notification process initiated.";
  }

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




