const Alexa = require('ask-sdk-core');
const admin = require('firebase-admin');
const express = require('express');
const { ExpressAdapter } = require('ask-sdk-express-adapter');
const getRawBody = require('raw-body');

// Initialize Firebase
async function initFirebase() {
  if (admin.apps.length > 0) return;
  
  try {
    let serviceAccount;

    // Method 1: Base64 encoded service account (FIREBASE_SA_B64)
    if (process.env.FIREBASE_SA_B64) {
      console.log('Using FIREBASE_SA_B64 for Firebase initialization');
      const serviceAccountJson = Buffer.from(process.env.FIREBASE_SA_B64, 'base64').toString('utf8');
      serviceAccount = JSON.parse(serviceAccountJson);
    }
    // Method 2: Individual environment variables
    else if (process.env.FIREBASE_PRIVATE_KEY) {
      console.log('Using individual env vars for Firebase initialization');
      serviceAccount = {
        type: "service_account",
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
      };
    }
    // Method 3: JSON string (legacy)
    else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      console.log('Using FIREBASE_SERVICE_ACCOUNT JSON for Firebase initialization');
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    }
    else {
      throw new Error('No Firebase service account configuration found in environment variables. Please set FIREBASE_SA_B64, FIREBASE_SERVICE_ACCOUNT, or individual Firebase env vars.');
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID
    });
    console.log('Firebase initialized successfully');
  } catch (error) {
    console.error('Firebase initialization failed:', error);
    console.error('Available env vars:', {
      FIREBASE_SA_B64: process.env.FIREBASE_SA_B64 ? `Set (${process.env.FIREBASE_SA_B64.length} chars)` : 'Not set',
      FIREBASE_SERVICE_ACCOUNT: process.env.FIREBASE_SERVICE_ACCOUNT ? `Set (${process.env.FIREBASE_SERVICE_ACCOUNT.length} chars)` : 'Not set',
      FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || 'Not set',
      FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY ? 'Set' : 'Not set'
    });
    throw error;
  }
}

// Initialize Firebase on startup with proper async handling
let firebaseInitialized = false;
async function ensureFirebaseInitialized() {
  if (!firebaseInitialized) {
    try {
      await initFirebase();
      firebaseInitialized = true;
    } catch (error) {
      console.error('Initial Firebase init failed:', error);
      throw error;
    }
  }
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

// Helper function to format Alexa date for speech
function formatAlexaDate(dateStr) {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
  } catch (error) {
    return dateStr; // Fallback to original string
  }
}

// Generate session code from session name
function generateSessionCode(sessionName) {
  // Create a simple code from the session name
  const code = sessionName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 8);
  
  // Add timestamp to make it unique
  const timestamp = Date.now().toString(36);
  return `${code}_${timestamp}`;
}

// Firebase operations - UPDATED DATABASE STRUCTURE to match web app
async function getUserData(uid) {
  await ensureFirebaseInitialized();
  const db = admin.firestore();
  const docRef = db.collection('attendance').doc(uid);
  const doc = await docRef.get();
  return doc.exists ? doc.data() : {};
}

async function updateUserData(uid, updates) {
  await ensureFirebaseInitialized();
  const db = admin.firestore();
  const docRef = db.collection('attendance').doc(uid);
  await docRef.set(updates, { merge: true });
}

async function getDayStatus(uid, date) {
  const userData = await getUserData(uid);
  
  // Check records first (matches web app structure)
  if (userData.records && userData.records[date] !== undefined) {
    return userData.records[date] ? 'present' : 'absent';
  }
  
  // Check holidays (matches web app structure)
  if (userData.holidays && userData.holidays.some(h => h.date === date)) {
    const holiday = userData.holidays.find(h => h.date === date);
    return { status: 'holiday', name: holiday.name };
  }
  
  // Check not enrolled (matches web app structure)
  if (userData.notEnrolled && userData.notEnrolled.includes(date)) {
    return 'not-enrolled';
  }
  
  return null;
}

async function setDayStatus(uid, date, status, extraData = {}) {
  const userData = await getUserData(uid);
  
  // Initialize data structures if they don't exist (matches web app structure)
  const records = userData.records || {};
  let holidays = userData.holidays || [];
  let notEnrolled = userData.notEnrolled || [];
  
  // Remove date from all status types first
  delete records[date];
  holidays = holidays.filter(h => h.date !== date);
  notEnrolled = notEnrolled.filter(d => d !== date);
  
  // Add to appropriate status
  if (status === 'present') {
    records[date] = true;
  } else if (status === 'absent') {
    records[date] = false;
  } else if (status === 'holiday') {
    holidays.push({ date, name: extraData.holidayName || 'Holiday' });
  } else if (status === 'not-enrolled') {
    notEnrolled.push(date);
  }
  
  // Update Firestore (matches web app structure)
  await updateUserData(uid, {
    records,
    holidays,
    notEnrolled,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  
  return { success: true };
}

// Check if a date is a non-working day (Sunday or weekly day off)
function isNonWorkingDay(dateStr, userData) {
  const date = new Date(dateStr);
  const dayOfWeek = date.getDay(); // 0 = Sunday, 1 = Monday, etc.
  
  // Always Sunday
  if (dayOfWeek === 0) return true;
  
  // Check weekly days off (matches web app structure)
  const weeklyDaysOff = userData.weeklyDaysOff || [];
  if (weeklyDaysOff.includes(dayOfWeek)) return true;
  
  return false;
}

// Monthly attendance calculation - updated to match web app structure
async function calculateMonthlyAttendance(uid, yearMonth) {
  const userData = await getUserData(uid);
  const [year, month] = yearMonth.split('-').map(Number);
  
  const daysInMonth = new Date(year, month, 0).getDate();
  let presentDays = 0;
  let totalWorkingDays = 0;
  const today = getFormattedDate();
  
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    
    // Skip future dates
    if (dateStr > today) continue;
    
    // Check if it's a non-working day
    if (isNonWorkingDay(dateStr, userData)) continue;
    
    // Check if it's a holiday (matches web app structure)
    const isHoliday = userData.holidays && userData.holidays.some(h => h.date === dateStr);
    if (isHoliday) continue;
    
    // Check if not enrolled (matches web app structure)
    const isNotEnrolled = userData.notEnrolled && userData.notEnrolled.includes(dateStr);
    if (isNotEnrolled) continue;
    
    // Count as working day
    totalWorkingDays++;
    
    // Check if present (matches web app structure)
    if (userData.records && userData.records[dateStr] === true) {
      presentDays++;
    }
  }
  
  return totalWorkingDays > 0 ? Math.round((presentDays / totalWorkingDays) * 100) : 0;
}

// NEW: Find Alexa preset session
async function findAlexaPresetSession(uid) {
  const userData = await getUserData(uid);
  
  if (!userData.sessions || !Array.isArray(userData.sessions)) {
    return null;
  }
  
  // Find session with alexapresetvalue
  return userData.sessions.find(session => 
    session.alexapresetvalue === true
  );
}

// NEW: Set Alexa preset session
async function setAlexaPresetSession(uid, sessionIdentifier) {
  const userData = await getUserData(uid);
  
  if (!userData.sessions || !Array.isArray(userData.sessions)) {
    return { success: false, error: 'No sessions found' };
  }
  
  // First, clear alexapresetvalue from all sessions
  const updatedSessions = userData.sessions.map(session => ({
    ...session,
    alexapresetvalue: false
  }));
  
  // Find the target session and set alexapresetvalue to true
  let sessionFound = false;
  const finalSessions = updatedSessions.map(session => {
    if (session.code === sessionIdentifier || session.name.toLowerCase() === sessionIdentifier.toLowerCase()) {
      sessionFound = true;
      return {
        ...session,
        alexapresetvalue: true
      };
    }
    return session;
  });
  
  if (!sessionFound) {
    return { success: false, error: 'Session not found' };
  }
  
  // Update the sessions in database
  await updateUserData(uid, { sessions: finalSessions });
  
  return { success: true };
}

// Session attendance calculation - UPDATED to use alexapresetvalue
async function calculateSessionAttendance(uid, sessionName = null) {
  const userData = await getUserData(uid);
  
  let startDate, endDate, sessionInfo = null;
  
  // If session name is provided, use that
  if (sessionName) {
    if (userData.sessions) {
      const session = userData.sessions.find(s => 
        s.name.toLowerCase() === sessionName.toLowerCase() || 
        s.code === sessionName
      );
      if (session) {
        startDate = session.startDate;
        endDate = session.endDate;
        sessionInfo = session;
      }
    }
  } else {
    // No session name provided - look for alexapresetvalue
    const presetSession = await findAlexaPresetSession(uid);
    if (presetSession) {
      startDate = presetSession.startDate;
      endDate = presetSession.endDate;
      sessionInfo = presetSession;
    } else {
      // Fallback to current year if no preset session
      const currentYear = getLocalDate().getUTCFullYear();
      startDate = `${currentYear}-01-01`;
      endDate = `${currentYear}-12-31`;
    }
  }
  
  // If no session found at all, use current year
  if (!startDate || !endDate) {
    const currentYear = getLocalDate().getUTCFullYear();
    startDate = `${currentYear}-01-01`;
    endDate = `${currentYear}-12-31`;
  }
  
  const start = new Date(startDate);
  const end = new Date(endDate);
  const today = new Date(getFormattedDate());
  
  let presentDays = 0;
  let totalWorkingDays = 0;
  
  const currentDate = new Date(start);
  while (currentDate <= end && currentDate <= today) {
    const dateStr = currentDate.toISOString().split('T')[0];
    
    // Check if it's a non-working day
    if (isNonWorkingDay(dateStr, userData)) {
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }
    
    // Check if it's a holiday
    const isHoliday = userData.holidays && userData.holidays.some(h => h.date === dateStr);
    if (isHoliday) {
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }
    
    // Check if not enrolled
    const isNotEnrolled = userData.notEnrolled && userData.notEnrolled.includes(dateStr);
    if (isNotEnrolled) {
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }
    
    // Count as working day
    totalWorkingDays++;
    
    // Check if present
    if (userData.records && userData.records[dateStr] === true) {
      presentDays++;
    }
    
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  return {
    percentage: totalWorkingDays > 0 ? Math.round((presentDays / totalWorkingDays) * 100) : 0,
    sessionInfo
  };
}

// Save session with auto-generated code and alexapresetvalue
async function saveSession(uid, sessionName, startDate, endDate, setAsPreset = true) {
  const userData = await getUserData(uid);
  const sessions = userData.sessions || [];
  
  // Generate session code
  const sessionCode = generateSessionCode(sessionName);
  
  // First, clear alexapresetvalue from all existing sessions if setting this as preset
  let updatedSessions = sessions;
  if (setAsPreset) {
    updatedSessions = sessions.map(session => ({
      ...session,
      alexapresetvalue: false
    }));
  }
  
  const sessionData = {
    name: sessionName,
    code: sessionCode,
    startDate,
    endDate,
    alexapresetvalue: setAsPreset, // Set as preset if requested
    createdAt: new Date().toISOString()
  };
  
  // Check if session already exists by name or code
  const existingIndex = updatedSessions.findIndex(s => 
    s.name.toLowerCase() === sessionName.toLowerCase() || 
    s.code === sessionCode
  );
  
  if (existingIndex !== -1) {
    updatedSessions[existingIndex] = sessionData;
  } else {
    updatedSessions.push(sessionData);
  }
  
  // Sort by creation date (newest first)
  updatedSessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  await updateUserData(uid, { sessions: updatedSessions });
  
  return sessionData;
}

// Get available sessions for user
async function getAvailableSessions(uid) {
  const userData = await getUserData(uid);
  return userData.sessions || [];
}

// Intent Handlers
const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    
    if (!accessToken) {
      return requireAccountLinking(handlerInput);
    }
    
    // Check if user has a preset session
    try {
      const uid = getUserKey(handlerInput);
      const presetSession = await findAlexaPresetSession(uid);
      
      let welcomeText = 'Welcome to Attendance Tracker! ';
      if (presetSession) {
        welcomeText += `I see your current session is ${presetSession.name}. `;
      }
      welcomeText += 'You can mark your attendance as present, absent, or holiday. You can also ask for monthly or session attendance percentages. What would you like to do?';
      
      return handlerInput.responseBuilder
        .speak(welcomeText)
        .reprompt('What would you like to do? You can say mark present, mark absent, or ask for attendance percentage.')
        .getResponse();
    } catch (error) {
      console.error('Error in LaunchRequest:', error);
      
      return handlerInput.responseBuilder
        .speak('Welcome to Attendance Tracker! You can mark your attendance as present, absent, or holiday. You can also ask for monthly or session attendance percentages. What would you like to do?')
        .reprompt('What would you like to do? You can say mark present, mark absent, or ask for attendance percentage.')
        .getResponse();
    }
  }
};

// ... (Keep all your existing intent handlers MarkPresentIntentHandler, MarkAbsentIntentHandler, etc. the same)

const SessionAttendanceIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'SessionAttendanceIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    const sessionName = Alexa.getSlotValue(handlerInput.requestEnvelope, 'sessionName');
    
    try {
      const uid = getUserKey(handlerInput);
      
      // Calculate attendance
      const result = await calculateSessionAttendance(uid, sessionName);
      
      let sessionText = 'for your current session';
      if (result.sessionInfo) {
        sessionText = `for ${result.sessionInfo.name} session`;
      } else if (sessionName) {
        sessionText = `for ${sessionName} session`;
      }
      
      return handlerInput.responseBuilder
        .speak(`Your session attendance ${sessionText} is ${result.percentage} percent.`)
        .getResponse();
        
    } catch (error) {
      console.error('Error in SessionAttendanceIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while fetching session attendance. Please try again.')
        .getResponse();
    }
  }
};

// UPDATED SelectSessionIntentHandler - uses alexapresetvalue instead of selectedSession
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
      // List available sessions
      try {
        const uid = getUserKey(handlerInput);
        const sessions = await getAvailableSessions(uid);
        
        if (sessions.length === 0) {
          return handlerInput.responseBuilder
            .speak('You don\'t have any sessions yet. Please create a session first by saying "create session".')
            .getResponse();
        }
        
        let sessionList = sessions.slice(0, 5).map(s => s.name).join(', ');
        if (sessions.length > 5) {
          sessionList += ', and more';
        }
        
        // Also mention which session is currently preset
        const presetSession = await findAlexaPresetSession(uid);
        let presetText = '';
        if (presetSession) {
          presetText = ` Your current session is ${presetSession.name}.`;
        }
        
        return handlerInput.responseBuilder
          .speak(`Your available sessions are: ${sessionList}.${presetText} Which session would you like to use?`)
          .reprompt('Please tell me which session you want to use.')
          .getResponse();
          
      } catch (error) {
        console.error('Error listing sessions:', error);
        return handlerInput.responseBuilder
          .speak('Sorry, I encountered an error while fetching your sessions. Please try again.')
          .getResponse();
      }
    }
    
    try {
      const uid = getUserKey(handlerInput);
      
      // Set the session as Alexa preset
      const result = await setAlexaPresetSession(uid, sessionName);
      
      if (result.success) {
        return handlerInput.responseBuilder
          .speak(`Okay, I've set ${sessionName} as your current session.`)
          .getResponse();
      } else {
        // Session not found, show available sessions
        const sessions = await getAvailableSessions(uid);
        
        if (sessions.length === 0) {
          return handlerInput.responseBuilder
            .speak(`Session "${sessionName}" not found. You don't have any sessions yet. Please create a session first by saying "create session".`)
            .getResponse();
        }
        
        let sessionList = sessions.slice(0, 5).map(s => s.name).join(', ');
        if (sessions.length > 5) {
          sessionList += ', and more';
        }
        
        return handlerInput.responseBuilder
          .speak(`Session "${sessionName}" not found. Your available sessions are: ${sessionList}. Which session would you like to use?`)
          .reprompt('Please tell me which session you want to use.')
          .getResponse();
      }
        
    } catch (error) {
      console.error('Error in SelectSessionIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while setting your session. Please try again.')
        .getResponse();
    }
  }
};

// UPDATED CreateSessionIntentHandler - automatically sets alexapresetvalue
const CreateSessionIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'CreateSessionIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    // Start session creation flow
    const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
    sessionAttributes.inSessionCreation = true;
    sessionAttributes.sessionCreationStep = 'name';
    handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
    
    return handlerInput.responseBuilder
      .speak('Okay, let\'s create a new session. What would you like to name this session? For example, "Summer 2024" or "Academic Year 2024-25".')
      .reprompt('What should I call this session?')
      .getResponse();
  }
};

// UPDATED DateIntentHandler for session creation - automatically sets alexapresetvalue
const DateIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'DateIntent';
  },
  async handle(handlerInput) {
    const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
    const uid = getUserKey(handlerInput);
    
    // Handle session creation flow
    if (sessionAttributes.inSessionCreation) {
      const dateValue = Alexa.getSlotValue(handlerInput.requestEnvelope, 'date');
      
      if (sessionAttributes.sessionCreationStep === 'startDate') {
        if (dateValue) {
          sessionAttributes.pendingStartDate = dateValue;
          sessionAttributes.sessionCreationStep = 'endDate';
          handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
          
          return handlerInput.responseBuilder
            .speak(`Okay, starting on ${formatAlexaDate(dateValue)}. When does the session end?`)
            .reprompt('Please provide an end date for the session.')
            .getResponse();
        } else {
          return handlerInput.responseBuilder
            .speak('I didn\'t catch the start date. Please provide a start date like "June 1st 2024" or "2024-06-01".')
            .reprompt('When does the session start?')
            .getResponse();
        }
      } 
      else if (sessionAttributes.sessionCreationStep === 'endDate') {
        if (dateValue) {
          const sessionName = sessionAttributes.pendingSessionName;
          const startDate = sessionAttributes.pendingStartDate;
          const endDate = dateValue;
          
          // Save the session with auto-generated code and set as preset
          const sessionData = await saveSession(uid, sessionName, startDate, endDate, true);
          
          // Clear session attributes
          delete sessionAttributes.inSessionCreation;
          delete sessionAttributes.sessionCreationStep;
          delete sessionAttributes.pendingSessionName;
          delete sessionAttributes.pendingStartDate;
          handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
          
          return handlerInput.responseBuilder
            .speak(`Successfully created session "${sessionData.name}" from ${formatAlexaDate(startDate)} to ${formatAlexaDate(endDate)}. I've also set it as your current session.`)
            .getResponse();
        } else {
          return handlerInput.responseBuilder
            .speak('I didn\'t catch the end date. Please provide an end date like "August 31st 2024" or "2024-08-31".')
            .reprompt('When does the session end?')
            .getResponse();
        }
      }
    }
    
    // If not in session creation, handle as generic date input
    const dateValue = Alexa.getSlotValue(handlerInput.requestEnvelope, 'date');
    if (dateValue) {
      return handlerInput.responseBuilder
        .speak(`You said the date is ${formatAlexaDate(dateValue)}. What would you like to do with this date?`)
        .reprompt('What would you like to do with this date?')
        .getResponse();
    }
    
    return handlerInput.responseBuilder
      .speak('I\'m not sure what date you\'re referring to. Please try again.')
      .getResponse();
  }
};

// NEW: GetAttendancePercentageIntent - handles the case when user asks for percentage without specifying session
const GetAttendancePercentageIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'GetAttendancePercentageIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    try {
      const uid = getUserKey(handlerInput);
      
      // Check if user has a preset session
      const presetSession = await findAlexaPresetSession(uid);
      
      if (presetSession) {
        // Calculate attendance for preset session
        const result = await calculateSessionAttendance(uid, null);
        return handlerInput.responseBuilder
          .speak(`Your attendance percentage for ${presetSession.name} session is ${result.percentage} percent.`)
          .getResponse();
      } else {
        // No preset session found, ask user to select one
        const sessions = await getAvailableSessions(uid);
        
        if (sessions.length === 0) {
          return handlerInput.responseBuilder
            .speak('You don\'t have any sessions yet. Please create a session first by saying "create session".')
            .getResponse();
        }
        
        let sessionList = sessions.slice(0, 5).map(s => s.name).join(', ');
        if (sessions.length > 5) {
          sessionList += ', and more';
        }
        
        return handlerInput.responseBuilder
          .speak(`I need to know which session you want the attendance for. Your available sessions are: ${sessionList}. Which session would you like to check?`)
          .reprompt('Please tell me which session you want to check attendance for.')
          .getResponse();
      }
        
    } catch (error) {
      console.error('Error in GetAttendancePercentageIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while fetching attendance percentage. Please try again.')
        .getResponse();
    }
  }
};

// ... (Keep all your other existing intent handlers the same: YesIntentHandler, NoIntentHandler, HelpIntentHandler, etc.)

// Create Alexa Skill
const skillBuilder = Alexa.SkillBuilders.custom();
const skill = skillBuilder
  .addRequestHandlers(
    LaunchRequestHandler,
    MarkPresentIntentHandler, // Keep your existing
    MarkAbsentIntentHandler,  // Keep your existing  
    MarkHolidayIntentHandler, // Keep your existing
    MonthlyAttendanceIntentHandler, // Keep your existing
    SessionAttendanceIntentHandler,
    SelectSessionIntentHandler,
    CreateSessionIntentHandler,
    CreateSessionWithNameIntentHandler, // Keep your existing
    GetAttendancePercentageIntentHandler, // NEW handler
    DateIntentHandler,
    YesIntentHandler, // Keep your existing
    NoIntentHandler, // Keep your existing
    HelpIntentHandler, // Keep your existing
    CancelAndStopIntentHandler, // Keep your existing
    FallbackIntentHandler, // Keep your existing
    SessionEndedRequestHandler // Keep your existing
  )
  .addErrorHandlers(ErrorHandler)
  .create();

// Express setup (keep the same as your original)
const app = express();
const adapter = new ExpressAdapter(skill, true, true);

// Fixed middleware with proper async handling
app.use(async (req, res, next) => {
  if (req.method === 'POST' && req.headers['content-type'] === 'application/json') {
    try {
      req.rawBody = await getRawBody(req, {
        length: req.headers['content-length'],
        limit: '1mb',
        encoding: 'utf8'
      });
      req.body = JSON.parse(req.rawBody.toString());
      next();
    } catch (error) {
      console.error('Error parsing body:', error);
      return res.status(400).json({ error: 'Bad Request - Invalid JSON' });
    }
  } else {
    next();
  }
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
