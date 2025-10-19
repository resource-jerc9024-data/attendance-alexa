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

// Firebase operations - Updated for single document structure
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
  
  // Check records first
  if (userData.records && userData.records[date] !== undefined) {
    return userData.records[date] ? 'present' : 'absent';
  }
  
  // Check holidays
  if (userData.holidays && userData.holidays.some(h => h.date === date)) {
    const holiday = userData.holidays.find(h => h.date === date);
    return { status: 'holiday', name: holiday.name };
  }
  
  // Check not enrolled
  if (userData.notEnrolled && userData.notEnrolled.includes(date)) {
    return 'not-enrolled';
  }
  
  return null;
}

async function setDayStatus(uid, date, status, extraData = {}) {
  const userData = await getUserData(uid);
  
  // Initialize data structures if they don't exist
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
  
  // Update Firestore
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
  
  // Check weekly days off
  const weeklyDaysOff = userData.weeklyDaysOff || [];
  if (weeklyDaysOff.includes(dayOfWeek)) return true;
  
  return false;
}

// Monthly attendance calculation - updated for web app structure
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
    
    // Check if it's a holiday
    const isHoliday = userData.holidays && userData.holidays.some(h => h.date === dateStr);
    if (isHoliday) continue;
    
    // Check if not enrolled
    const isNotEnrolled = userData.notEnrolled && userData.notEnrolled.includes(dateStr);
    if (isNotEnrolled) continue;
    
    // Count as working day
    totalWorkingDays++;
    
    // Check if present
    if (userData.records && userData.records[dateStr] === true) {
      presentDays++;
    }
  }
  
  return totalWorkingDays > 0 ? Math.round((presentDays / totalWorkingDays) * 100) : 0;
}

// Session attendance calculation - Updated to use selected session
async function calculateSessionAttendance(uid, sessionName = null) {
  const userData = await getUserData(uid);
  
  // Get session data - first check selectedSession, then sessions array
  let startDate, endDate;
  
  if (sessionName) {
    // Search for session by name in sessions array
    if (userData.sessions) {
      const session = userData.sessions.find(s => 
        s.name.toLowerCase() === sessionName.toLowerCase() || 
        s.code === sessionName
      );
      if (session) {
        startDate = session.startDate;
        endDate = session.endDate;
      }
    }
  } else {
    // Use selected session if no session name provided
    if (userData.selectedSession) {
      const selectedSession = userData.selectedSession;
      if (userData.sessions) {
        const session = userData.sessions.find(s => 
          s.name.toLowerCase() === selectedSession.name.toLowerCase() || 
          s.code === selectedSession.code
        );
        if (session) {
          startDate = session.startDate;
          endDate = session.endDate;
        }
      }
    }
  }
  
  // If no session found, use current year
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
  
  return totalWorkingDays > 0 ? Math.round((presentDays / totalWorkingDays) * 100) : 0;
}

// Session management - Updated to store selected session properly
async function setSelectedSession(uid, sessionName) {
  const userData = await getUserData(uid);
  
  // Search for session by name or code in sessions array
  let selectedSession = null;
  if (userData.sessions) {
    selectedSession = userData.sessions.find(s => 
      s.name.toLowerCase() === sessionName.toLowerCase() || 
      s.code === sessionName
    );
  }
  
  if (selectedSession) {
    // Store selected session with both name and code for linking
    await updateUserData(uid, {
      selectedSession: {
        name: selectedSession.name,
        code: selectedSession.code,
        startDate: selectedSession.startDate,
        endDate: selectedSession.endDate,
        selectedAt: new Date().toISOString()
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { success: true, session: selectedSession };
  } else {
    return { success: false, error: 'Session not found' };
  }
}

async function getSelectedSession(uid) {
  const userData = await getUserData(uid);
  return userData.selectedSession || null;
}

// Save session with auto-generated code
async function saveSession(uid, sessionName, startDate, endDate) {
  const userData = await getUserData(uid);
  const sessions = userData.sessions || [];
  
  // Generate session code
  const sessionCode = generateSessionCode(sessionName);
  
  const sessionData = {
    name: sessionName,
    code: sessionCode,
    startDate,
    endDate,
    createdAt: new Date().toISOString()
  };
  
  // Check if session already exists by name or code
  const existingIndex = sessions.findIndex(s => 
    s.name.toLowerCase() === sessionName.toLowerCase() || 
    s.code === sessionCode
  );
  
  if (existingIndex !== -1) {
    sessions[existingIndex] = sessionData;
  } else {
    sessions.push(sessionData);
  }
  
  // Sort by creation date (newest first)
  sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  await updateUserData(uid, { sessions });
  
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
      const userData = await getUserData(uid);
      
      // Check if it's a non-working day
      if (isNonWorkingDay(today, userData)) {
        return handlerInput.responseBuilder
          .speak('Today is a non-working day. You cannot mark attendance on non-working days.')
          .getResponse();
      }
      
      const existingStatus = await getDayStatus(uid, today);
      
      if (existingStatus) {
        if (existingStatus.status === 'present' || existingStatus === 'present') {
          return handlerInput.responseBuilder
            .speak('Today is already marked as present.')
            .getResponse();
        } else {
          // Ask for confirmation to change status
          const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
          sessionAttributes.pendingStatusChange = {
            date: today,
            newStatus: 'present',
            oldStatus: existingStatus.status || existingStatus
          };
          handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
          
          return handlerInput.responseBuilder
            .speak(`Today is currently marked as ${existingStatus.status || existingStatus}. Would you like to change it to present?`)
            .reprompt('Should I change today\'s status to present?')
            .getResponse();
        }
      }
      
      await setDayStatus(uid, today, 'present');
      
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
      const userData = await getUserData(uid);
      
      // Check if it's a non-working day
      if (isNonWorkingDay(today, userData)) {
        return handlerInput.responseBuilder
          .speak('Today is a non-working day. You cannot mark attendance on non-working days.')
          .getResponse();
      }
      
      const existingStatus = await getDayStatus(uid, today);
      
      if (existingStatus) {
        if (existingStatus.status === 'absent' || existingStatus === 'absent') {
          return handlerInput.responseBuilder
            .speak('Today is already marked as absent.')
            .getResponse();
        } else {
          // Ask for confirmation to change status
          const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
          sessionAttributes.pendingStatusChange = {
            date: today,
            newStatus: 'absent',
            oldStatus: existingStatus.status || existingStatus
          };
          handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
          
          return handlerInput.responseBuilder
            .speak(`Today is currently marked as ${existingStatus.status || existingStatus}. Would you like to change it to absent?`)
            .reprompt('Should I change today\'s status to absent?')
            .getResponse();
        }
      }
      
      await setDayStatus(uid, today, 'absent');
      
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
      
      const existingStatus = await getDayStatus(uid, today);
      
      if (existingStatus) {
        if (existingStatus.status === 'holiday' || existingStatus === 'holiday') {
          return handlerInput.responseBuilder
            .speak(`Today is already marked as holiday for ${existingStatus.name || 'a holiday'}.`)
            .getResponse();
        } else {
          // Ask for confirmation to change status
          const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
          sessionAttributes.pendingStatusChange = {
            date: today,
            newStatus: 'holiday',
            oldStatus: existingStatus.status || existingStatus,
            holidayName: holidayName
          };
          handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
          
          return handlerInput.responseBuilder
            .speak(`Today is currently marked as ${existingStatus.status || existingStatus}. Would you like to change it to holiday for ${holidayName}?`)
            .reprompt(`Should I change today\'s status to holiday for ${holidayName}?`)
            .getResponse();
        }
      }
      
      await setDayStatus(uid, today, 'holiday', { holidayName });
      
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
      
      // Get selected session info
      const selectedSession = await getSelectedSession(uid);
      const percentage = await calculateSessionAttendance(uid);
      
      let sessionText = 'for the current session';
      if (selectedSession) {
        sessionText = `for ${selectedSession.name} session`;
      }
      
      return handlerInput.responseBuilder
        .speak(`Your session attendance ${sessionText} is ${percentage} percent.`)
        .getResponse();
        
    } catch (error) {
      console.error('Error in SessionAttendanceIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while fetching session attendance. Please try again.')
        .getResponse();
    }
  }
};

// Updated SelectSessionIntentHandler with session search and linking
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
        
        return handlerInput.responseBuilder
          .speak(`Your available sessions are: ${sessionList}. Which session would you like to use?`)
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
      const result = await setSelectedSession(uid, sessionName);
      
      if (result.success) {
        return handlerInput.responseBuilder
          .speak(`Okay, I've set ${result.session.name} as your current session.`)
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

const CreateSessionWithNameIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'CreateSessionWithNameIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    const sessionName = Alexa.getSlotValue(handlerInput.requestEnvelope, 'sessionName');
    
    if (!sessionName) {
      return handlerInput.responseBuilder
        .speak('Please provide a session name. For example, say "create session called Summer 2024".')
        .reprompt('What would you like to name this session?')
        .getResponse();
    }
    
    try {
      const uid = getUserKey(handlerInput);
      
      // Store the session name in session attributes for follow-up
      const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
      sessionAttributes.inSessionCreation = true;
      sessionAttributes.sessionCreationStep = 'startDate';
      sessionAttributes.pendingSessionName = sessionName;
      handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
      
      return handlerInput.responseBuilder
        .speak(`Okay, I'll create session "${sessionName}". When does this session start? Please provide a start date like "June 1st 2024" or "2024-06-01".`)
        .reprompt('Please tell me the start date for this session.')
        .getResponse();
        
    } catch (error) {
      console.error('Error in CreateSessionWithNameIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while creating the session. Please try again.')
        .getResponse();
    }
  }
};

// Updated DateIntentHandler for session creation
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
          
          // Save the session with auto-generated code
          const sessionData = await saveSession(uid, sessionName, startDate, endDate);
          
          // Auto-select the newly created session
          await setSelectedSession(uid, sessionData.name);
          
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

const YesIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.YesIntent';
  },
  async handle(handlerInput) {
    const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
    
    // Handle status change confirmation
    if (sessionAttributes.pendingStatusChange) {
      const { date, newStatus, oldStatus, holidayName } = sessionAttributes.pendingStatusChange;
      const uid = getUserKey(handlerInput);
      
      try {
        await setDayStatus(uid, date, newStatus, { holidayName });
        
        // Clear the pending status change
        delete sessionAttributes.pendingStatusChange;
        handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
        
        let speechText = `Okay, I've changed ${date} from ${oldStatus} to ${newStatus}`;
        if (newStatus === 'holiday' && holidayName) {
          speechText += ` for ${holidayName}`;
        }
        speechText += '.';
        
        return handlerInput.responseBuilder
          .speak(speechText)
          .getResponse();
          
      } catch (error) {
        console.error('Error confirming status change:', error);
        return handlerInput.responseBuilder
          .speak('Sorry, I encountered an error while updating the status. Please try again.')
          .getResponse();
      }
    }
    
    // Handle generic "yes" to create session
    if (!sessionAttributes.inSessionCreation && !sessionAttributes.pendingStatusChange) {
      sessionAttributes.inSessionCreation = true;
      sessionAttributes.sessionCreationStep = 'name';
      handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
      
      return handlerInput.responseBuilder
        .speak('Great! What would you like to name this session? For example, "Summer 2024" or "Academic Year 2024-25".')
        .reprompt('What should I call this session?')
        .getResponse();
    }
    
    // Default response
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
    // Clear any pending status change or session creation
    const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
    if (sessionAttributes.pendingStatusChange) {
      delete sessionAttributes.pendingStatusChange;
    }
    if (sessionAttributes.inSessionCreation) {
      delete sessionAttributes.inSessionCreation;
      delete sessionAttributes.sessionCreationStep;
      delete sessionAttributes.pendingSessionName;
      delete sessionAttributes.pendingStartDate;
    }
    handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
    
    const speechText = 'Okay, I won\'t make any changes. Let me know if you need anything else.';
    
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
    const speechText = 'You can mark your attendance by saying: "mark present", "mark absent", or "mark holiday for [holiday name]". You can also ask for "monthly attendance" or "session attendance" to get your percentage. To create a session, say "create session" or "create session Summer 2024". When asked for dates, you can say things like "June first 2024" or "2024-06-01". To switch sessions, say "use session [session name]". What would you like to do?';
    
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
    CreateSessionIntentHandler,
    CreateSessionWithNameIntentHandler,
    DateIntentHandler,
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
