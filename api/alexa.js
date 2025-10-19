const Alexa = require('ask-sdk-core');
const admin = require('firebase-admin');
const express = require('express');
const { ExpressAdapter } = require('ask-sdk-express-adapter');
const getRawBody = require('raw-body');

// Initialize Firebase
function initFirebase() {
  if (admin.apps.length > 0) return;
  
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID
    });
    console.log('Firebase initialized successfully');
  } catch (error) {
    console.error('Firebase initialization failed:', error);
    throw error;
  }
}

// Initialize Firebase on startup
try {
  initFirebase();
} catch (error) {
  console.error('Initial Firebase init failed:', error);
}

// Utility functions
function getAccessToken(handlerInput) {
  try {
    return handlerInput.requestEnvelope.context.System.user.accessToken;
  } catch (error) {
    return null;
  }
}

function requireAccountLinking(handlerInput) {
  return handlerInput.responseBuilder
    .speak('Please link your account to continue. I sent a card to your Alexa app.')
    .withLinkAccountCard()
    .getResponse();
}

function getUserKey(handlerInput) {
  try {
    return handlerInput.requestEnvelope.context.System.user.userId;
  } catch (error) {
    return 'anonymous';
  }
}

// Date helpers
function getLocalDate() {
  const timezoneOffset = parseInt(process.env.TIMEZONE_OFFSET_MINUTES || '330');
  const now = new Date();
  return new Date(now.getTime() + timezoneOffset * 60000);
}

function getFormattedDate() {
  const date = getLocalDate();
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getYearMonthFromDate(dateStr = null) {
  const date = dateStr ? new Date(dateStr) : getLocalDate();
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// Firebase operations
async function getAttendance(uid, date) {
  initFirebase();
  const db = admin.firestore();
  const [year, month] = date.split('-');
  const docRef = db.collection('attendance')
    .doc(uid)
    .collection(year)
    .doc(`${year}-${month}`)
    .collection('days')
    .doc(date);
  
  const doc = await docRef.get();
  return doc.exists ? doc.data() : null;
}

async function setAttendance(uid, date, status, extraData = {}) {
  initFirebase();
  const db = admin.firestore();
  const [year, month] = date.split('-');
  const docRef = db.collection('attendance')
    .doc(uid)
    .collection(year)
    .doc(`${year}-${month}`)
    .collection('days')
    .doc(date);
  
  const data = {
    status,
    ...extraData,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    date: date
  };
  
  await docRef.set(data, { merge: true });
  return { success: true };
}

// Attendance percentage calculation
async function calculateMonthlyAttendance(uid, yearMonth) {
  initFirebase();
  const db = admin.firestore();
  const [year, month] = yearMonth.split('-');
  
  const daysRef = db.collection('attendance')
    .doc(uid)
    .collection(year)
    .doc(`${year}-${month}`)
    .collection('days');
  
  const snapshot = await daysRef.get();
  
  if (snapshot.empty) {
    return 0;
  }
  
  let presentDays = 0;
  let totalDays = 0;
  
  snapshot.forEach(doc => {
    const data = doc.data();
    if (data.status === 'present') {
      presentDays++;
    }
    if (data.status && data.status !== 'holiday') {
      totalDays++;
    }
  });
  
  return totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0;
}

async function calculateSessionAttendance(uid) {
  initFirebase();
  const db = admin.firestore();
  
  // Get current session (you can modify this logic based on your session structure)
  const currentYear = getLocalDate().getUTCFullYear().toString();
  let totalPresent = 0;
  let totalDays = 0;
  
  try {
    const yearRef = db.collection('attendance').doc(uid).collection(currentYear);
    const months = await yearRef.listDocuments();
    
    for (const monthDoc of months) {
      const daysRef = monthDoc.collection('days');
      const daysSnapshot = await daysRef.get();
      
      daysSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.status === 'present') {
          totalPresent++;
        }
        if (data.status && data.status !== 'holiday') {
          totalDays++;
        }
      });
    }
    
    return totalDays > 0 ? Math.round((totalPresent / totalDays) * 100) : 0;
  } catch (error) {
    console.error('Error calculating session attendance:', error);
    return 0;
  }
}

// Session management
async function setSelectedSession(uid, sessionName) {
  initFirebase();
  const db = admin.firestore();
  const sessionRef = db.collection('sessions').doc(uid);
  
  await sessionRef.set({
    selectedSession: sessionName,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

async function getSelectedSession(uid) {
  initFirebase();
  const db = admin.firestore();
  const sessionRef = db.collection('sessions').doc(uid);
  const doc = await sessionRef.get();
  
  return doc.exists ? doc.data().selectedSession : null;
}

// Intent Handlers
const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    
    if (!accessToken) {
      return requireAccountLinking(handlerInput);
    }
    
    const speechText = 'Welcome to Attendance Tracker! You can mark your attendance as present, absent, or holiday. You can also ask for monthly or session attendance percentages. What would you like to do?';
    
    return handlerInput.responseBuilder
      .speak(speechText)
      .reprompt('What would you like to do? You can say mark present, mark absent, or ask for attendance percentage.')
      .getResponse();
  }
};

const MarkPresentIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'MarkPresentIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    try {
      const uid = getUserKey(handlerInput);
      const today = getFormattedDate();
      
      const existing = await getAttendance(uid, today);
      if (existing && existing.status) {
        return handlerInput.responseBuilder
          .speak(`Today is already marked as ${existing.status}.`)
          .getResponse();
      }
      
      await setAttendance(uid, today, 'present');
      
      return handlerInput.responseBuilder
        .speak('Successfully marked as present for today.')
        .getResponse();
        
    } catch (error) {
      console.error('Error in MarkPresentIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while marking attendance. Please try again.')
        .getResponse();
    }
  }
};

const MarkAbsentIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'MarkAbsentIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    try {
      const uid = getUserKey(handlerInput);
      const today = getFormattedDate();
      
      const existing = await getAttendance(uid, today);
      if (existing && existing.status) {
        return handlerInput.responseBuilder
          .speak(`Today is already marked as ${existing.status}.`)
          .getResponse();
      }
      
      await setAttendance(uid, today, 'absent');
      
      return handlerInput.responseBuilder
        .speak('Successfully marked as absent for today.')
        .getResponse();
        
    } catch (error) {
      console.error('Error in MarkAbsentIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while marking attendance. Please try again.')
        .getResponse();
    }
  }
};

const MarkHolidayIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'MarkHolidayIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    const holidayName = Alexa.getSlotValue(handlerInput.requestEnvelope, 'holidayName');
    
    if (!holidayName) {
      return handlerInput.responseBuilder
        .speak('Please specify the holiday name. For example, say "mark holiday for Diwali".')
        .reprompt('What is the name of the holiday?')
        .getResponse();
    }
    
    try {
      const uid = getUserKey(handlerInput);
      const today = getFormattedDate();
      
      const existing = await getAttendance(uid, today);
      if (existing && existing.status) {
        return handlerInput.responseBuilder
          .speak(`Today is already marked as ${existing.status}.`)
          .getResponse();
      }
      
      await setAttendance(uid, today, 'holiday', { holidayName });
      
      return handlerInput.responseBuilder
        .speak(`Successfully marked as holiday for ${holidayName}.`)
        .getResponse();
        
    } catch (error) {
      console.error('Error in MarkHolidayIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while marking holiday. Please try again.')
        .getResponse();
    }
  }
};

const MonthlyAttendanceIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'MonthlyAttendanceIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    try {
      const uid = getUserKey(handlerInput);
      const monthSlot = Alexa.getSlotValue(handlerInput.requestEnvelope, 'month');
      const yearMonth = monthSlot ? getYearMonthFromDate(monthSlot) : getYearMonthFromDate();
      
      const percentage = await calculateMonthlyAttendance(uid, yearMonth);
      
      const monthName = new Date(yearMonth + '-01').toLocaleString('en-US', { month: 'long', year: 'numeric' });
      
      return handlerInput.responseBuilder
        .speak(`Your attendance for ${monthName} is ${percentage} percent.`)
        .getResponse();
        
    } catch (error) {
      console.error('Error in MonthlyAttendanceIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while fetching monthly attendance. Please try again.')
        .getResponse();
    }
  }
};

const SessionAttendanceIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'SessionAttendanceIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    try {
      const uid = getUserKey(handlerInput);
      const percentage = await calculateSessionAttendance(uid);
      
      return handlerInput.responseBuilder
        .speak(`Your session attendance is ${percentage} percent.`)
        .getResponse();
        
    } catch (error) {
      console.error('Error in SessionAttendanceIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while fetching session attendance. Please try again.')
        .getResponse();
    }
  }
};

const SelectSessionIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'SelectSessionIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    const sessionName = Alexa.getSlotValue(handlerInput.requestEnvelope, 'sessionName');
    
    if (!sessionName) {
      return handlerInput.responseBuilder
        .speak('Please specify which session you want to use. For example, say "use session summer 2024".')
        .reprompt('Which session would you like to use?')
        .getResponse();
    }
    
    try {
      const uid = getUserKey(handlerInput);
      await setSelectedSession(uid, sessionName);
      
      return handlerInput.responseBuilder
        .speak(`Okay, I've set ${sessionName} as your current session.`)
        .getResponse();
        
    } catch (error) {
      console.error('Error in SelectSessionIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while setting your session. Please try again.')
        .getResponse();
    }
  }
};

const YesIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.YesIntent';
  },
  handle(handlerInput) {
    const speechText = 'Okay, what would you like to do next?';
    
    return handlerInput.responseBuilder
      .speak(speechText)
      .reprompt(speechText)
      .getResponse();
  }
};

const NoIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.NoIntent';
  },
  handle(handlerInput) {
    const speechText = 'Okay, let me know if you need anything else.';
    
    return handlerInput.responseBuilder
      .speak(speechText)
      .getResponse();
  }
};

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
  },
  handle(handlerInput) {
    const speechText = 'You can mark your attendance by saying: "mark present", "mark absent", or "mark holiday for [holiday name]". You can also ask for "monthly attendance" or "session attendance" to get your percentage. What would you like to do?';
    
    return handlerInput.responseBuilder
      .speak(speechText)
      .reprompt(speechText)
      .getResponse();
  }
};

const CancelAndStopIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.CancelIntent' ||
            Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.StopIntent');
  },
  handle(handlerInput) {
    const speechText = 'Goodbye! Have a great day!';
    
    return handlerInput.responseBuilder
      .speak(speechText)
      .getResponse();
  }
};

const FallbackIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent';
  },
  handle(handlerInput) {
    const speechText = 'Sorry, I didn\'t understand that. You can mark attendance, ask for percentages, or say help for more options. What would you like to do?';
    
    return handlerInput.responseBuilder
      .speak(speechText)
      .reprompt(speechText)
      .getResponse();
  }
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },
  handle(handlerInput) {
    console.log('Session ended with reason:', handlerInput.requestEnvelope.request.reason);
    return handlerInput.responseBuilder.getResponse();
  }
};

const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    console.log('Error handled:', error);
    
    return handlerInput.responseBuilder
      .speak('Sorry, I had trouble doing what you asked. Please try again.')
      .reprompt('Please try again.')
      .getResponse();
  }
};

// Create Alexa Skill
const skillBuilder = Alexa.SkillBuilders.custom();
const skill = skillBuilder
  .addRequestHandlers(
    LaunchRequestHandler,
    MarkPresentIntentHandler,
    MarkAbsentIntentHandler,
    MarkHolidayIntentHandler,
    MonthlyAttendanceIntentHandler,
    SessionAttendanceIntentHandler,
    SelectSessionIntentHandler,
    YesIntentHandler,
    NoIntentHandler,
    HelpIntentHandler,
    CancelAndStopIntentHandler,
    FallbackIntentHandler,
    SessionEndedRequestHandler
  )
  .addErrorHandlers(ErrorHandler)
  .create();

// Express setup
const app = express();
const adapter = new ExpressAdapter(skill, true, true);

// Middleware to parse raw body for Alexa verification
app.use(async (req, res, next) => {
  if (req.method === 'POST') {
    try {
      req.rawBody = await getRawBody(req);
      req.body = JSON.parse(req.rawBody.toString());
    } catch (error) {
      console.error('Error parsing body:', error);
      return res.status(400).send('Bad Request');
    }
  }
  next();
});

// Alexa endpoint
app.post('*', adapter.getRequestHandlers());

// Health check endpoint
app.get('*', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Attendance Skill is running',
    timestamp: new Date().toISOString()
  });
});

// Export for Vercel
module.exports = app;