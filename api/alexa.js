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

    if (process.env.FIREBASE_SA_B64) {
      console.log('Using FIREBASE_SA_B64 for Firebase initialization');
      const serviceAccountJson = Buffer.from(process.env.FIREBASE_SA_B64, 'base64').toString('utf8');
      serviceAccount = JSON.parse(serviceAccountJson);
    }
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
    else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      console.log('Using FIREBASE_SERVICE_ACCOUNT JSON for Firebase initialization');
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    }
    else {
      throw new Error('No Firebase service account configuration found in environment variables.');
    }

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

// NEW: Get the actual attendance key from credentials
async function getAttendanceKey(uid) {
  await ensureFirebaseInitialized();
  const db = admin.firestore();
  
  try {
    // Look in credentials collection for the user's key
    const credsRef = db.collection('credentials').doc(uid);
    const credsDoc = await credsRef.get();
    
    if (credsDoc.exists) {
      const data = credsDoc.data();
      return data.key || uid; // Return the key or fallback to uid
    }
    
    // If no credentials found, use uid as fallback
    return uid;
  } catch (error) {
    console.error('Error getting attendance key:', error);
    return uid; // Fallback to uid
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

function formatAlexaDate(dateStr) {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
  } catch (error) {
    return dateStr;
  }
}

// Generate session code
function generateSessionCode(sessionName) {
  const code = sessionName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 8);
  const timestamp = Date.now().toString(36);
  return `${code}_${timestamp}`;
}

// NEW: Get user data using the correct key structure
async function getUserData(uid) {
  await ensureFirebaseInitialized();
  const db = admin.firestore();
  
  // Get the actual attendance key first
  const attendanceKey = await getAttendanceKey(uid);
  
  // Now get data from attendance collection with the correct key
  const docRef = db.collection('attendance').doc(attendanceKey);
  const doc = await docRef.get();
  return doc.exists ? doc.data() : {};
}

// NEW: Update user data using correct key structure
async function updateUserData(uid, updates) {
  await ensureFirebaseInitialized();
  const db = admin.firestore();
  
  // Get the actual attendance key first
  const attendanceKey = await getAttendanceKey(uid);
  
  const docRef = db.collection('attendance').doc(attendanceKey);
  await docRef.set(updates, { merge: true });
}

// NEW: Get day status with correct structure
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

// NEW: Set day status with correct structure
async function setDayStatus(uid, date, status, extraData = {}) {
  const userData = await getUserData(uid);
  
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
  
  await updateUserData(uid, {
    records,
    holidays,
    notEnrolled,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  
  return { success: true };
}

// Check if a date is a non-working day
function isNonWorkingDay(dateStr, userData) {
  const date = new Date(dateStr);
  const dayOfWeek = date.getDay();
  
  if (dayOfWeek === 0) return true;
  
  const weeklyDaysOff = userData.weeklyDaysOff || [];
  if (weeklyDaysOff.includes(dayOfWeek)) return true;
  
  return false;
}

// NEW: Monthly attendance calculation with correct structure
async function calculateMonthlyAttendance(uid, yearMonth) {
  const userData = await getUserData(uid);
  const [year, month] = yearMonth.split('-').map(Number);
  
  const daysInMonth = new Date(year, month, 0).getDate();
  let presentDays = 0;
  let totalWorkingDays = 0;
  const today = getFormattedDate();
  
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    
    if (dateStr > today) continue;
    if (isNonWorkingDay(dateStr, userData)) continue;
    
    const isHoliday = userData.holidays && userData.holidays.some(h => h.date === dateStr);
    if (isHoliday) continue;
    
    const isNotEnrolled = userData.notEnrolled && userData.notEnrolled.includes(dateStr);
    if (isNotEnrolled) continue;
    
    totalWorkingDays++;
    
    if (userData.records && userData.records[dateStr] === true) {
      presentDays++;
    }
  }
  
  return totalWorkingDays > 0 ? Math.round((presentDays / totalWorkingDays) * 100) : 0;
}

// NEW: Session attendance calculation with Alexa preset value
async function calculateSessionAttendance(uid, sessionName = null) {
  const userData = await getUserData(uid);
  
  let startDate, endDate;
  let sessionUsed = 'current session';
  
  // NEW: Look for Alexa preset session first
  if (userData.sessions) {
    // Find session with alexapresetvalue
    const presetSession = userData.sessions.find(s => s.alexapresetvalue === true);
    if (presetSession) {
      startDate = presetSession.startDate;
      endDate = presetSession.endDate;
      sessionUsed = presetSession.name;
    }
  }
  
  // If no preset found and session name provided, search by name
  if ((!startDate || !endDate) && sessionName) {
    if (userData.sessions) {
      const session = userData.sessions.find(s => 
        s.name.toLowerCase() === sessionName.toLowerCase() || 
        s.code === sessionName
      );
      if (session) {
        startDate = session.startDate;
        endDate = session.endDate;
        sessionUsed = session.name;
      }
    }
  }
  
  // If still no session found, use current year
  if (!startDate || !endDate) {
    const currentYear = getLocalDate().getUTCFullYear();
    startDate = `${currentYear}-01-01`;
    endDate = `${currentYear}-12-31`;
    sessionUsed = 'current year';
  }
  
  const start = new Date(startDate);
  const end = new Date(endDate);
  const today = new Date(getFormattedDate());
  
  let presentDays = 0;
  let totalWorkingDays = 0;
  
  const currentDate = new Date(start);
  while (currentDate <= end && currentDate <= today) {
    const dateStr = currentDate.toISOString().split('T')[0];
    
    if (isNonWorkingDay(dateStr, userData)) {
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }
    
    const isHoliday = userData.holidays && userData.holidays.some(h => h.date === dateStr);
    if (isHoliday) {
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }
    
    const isNotEnrolled = userData.notEnrolled && userData.notEnrolled.includes(dateStr);
    if (isNotEnrolled) {
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }
    
    totalWorkingDays++;
    
    if (userData.records && userData.records[dateStr] === true) {
      presentDays++;
    }
    
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  const percentage = totalWorkingDays > 0 ? Math.round((presentDays / totalWorkingDays) * 100) : 0;
  
  return {
    percentage,
    sessionName: sessionUsed,
    presentDays,
    totalWorkingDays
  };
}

// NEW: Set Alexa preset session
async function setAlexaPresetSession(uid, sessionIdentifier) {
  const userData = await getUserData(uid);
  
  if (!userData.sessions || userData.sessions.length === 0) {
    return { success: false, error: 'No sessions found' };
  }
  
  // First, clear alexapresetvalue from all sessions
  const updatedSessions = userData.sessions.map(session => ({
    ...session,
    alexapresetvalue: false
  }));
  
  // Find the target session and set alexapresetvalue
  let targetSession = null;
  const sessionIndex = updatedSessions.findIndex(s => 
    s.code === sessionIdentifier || 
    s.name.toLowerCase() === sessionIdentifier.toLowerCase()
  );
  
  if (sessionIndex !== -1) {
    updatedSessions[sessionIndex].alexapresetvalue = true;
    targetSession = updatedSessions[sessionIndex];
    
    await updateUserData(uid, { sessions: updatedSessions });
    return { success: true, session: targetSession };
  }
  
  return { success: false, error: 'Session not found' };
}

// NEW: Get Alexa preset session
async function getAlexaPresetSession(uid) {
  const userData = await getUserData(uid);
  
  if (userData.sessions) {
    return userData.sessions.find(s => s.alexapresetvalue === true) || null;
  }
  
  return null;
}

// Save session with Alexa preset capability
async function saveSession(uid, sessionName, startDate, endDate, setAsPreset = false) {
  const userData = await getUserData(uid);
  const sessions = userData.sessions || [];
  
  const sessionCode = generateSessionCode(sessionName);
  
  const sessionData = {
    name: sessionName,
    code: sessionCode,
    startDate,
    endDate,
    createdAt: new Date().toISOString(),
    alexapresetvalue: setAsPreset
  };
  
  // If setting as preset, clear preset from other sessions
  if (setAsPreset) {
    sessions.forEach(session => {
      session.alexapresetvalue = false;
    });
  }
  
  const existingIndex = sessions.findIndex(s => 
    s.name.toLowerCase() === sessionName.toLowerCase() || 
    s.code === sessionCode
  );
  
  if (existingIndex !== -1) {
    sessions[existingIndex] = sessionData;
  } else {
    sessions.push(sessionData);
  }
  
  sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  await updateUserData(uid, { sessions });
  
  return sessionData;
}

// Get available sessions
async function getAvailableSessions(uid) {
  const userData = await getUserData(uid);
  return userData.sessions || [];
}

// Intent Handlers (ALL ASYNC FIXED)
const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  async handle(handlerInput) {
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

// NEW: Updated SessionAttendanceIntentHandler with Alexa preset
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
      const sessionNameSlot = Alexa.getSlotValue(handlerInput.requestEnvelope, 'sessionName');
      
      // Calculate attendance - will automatically use Alexa preset session if available
      const result = await calculateSessionAttendance(uid, sessionNameSlot);
      
      return handlerInput.responseBuilder
        .speak(`Your session attendance for ${result.sessionName} is ${result.percentage} percent. You have attended ${result.presentDays} out of ${result.totalWorkingDays} working days.`)
        .getResponse();
        
    } catch (error) {
      console.error('Error in SessionAttendanceIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while fetching session attendance. Please try again.')
        .getResponse();
    }
  }
};

// NEW: SetAlexaPresetIntentHandler
const SetAlexaPresetIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'SetAlexaPresetIntent';
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
        const presetSession = await getAlexaPresetSession(uid);
        
        if (sessions.length === 0) {
          return handlerInput.responseBuilder
            .speak('You don\'t have any sessions yet. Please create a session first by saying "create session".')
            .getResponse();
        }
        
        let speechText = `Your available sessions are: `;
        sessions.slice(0, 5).forEach((session, index) => {
          speechText += `${session.name}${session.alexapresetvalue ? ' (Alexa preset)' : ''}`;
          if (index < Math.min(sessions.length, 5) - 1) speechText += ', ';
        });
        
        if (presetSession) {
          speechText += `. Your current Alexa preset session is ${presetSession.name}.`;
        }
        
        speechText += ' Which session would you like to set as Alexa preset?';
        
        return handlerInput.responseBuilder
          .speak(speechText)
          .reprompt('Please tell me which session you want to set as Alexa preset.')
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
      const result = await setAlexaPresetSession(uid, sessionName);
      
      if (result.success) {
        return handlerInput.responseBuilder
          .speak(`Okay, I've set ${result.session.name} as your Alexa preset session. Now when you ask for session attendance, I'll automatically use this session.`)
          .getResponse();
      } else {
        return handlerInput.responseBuilder
          .speak(`Session "${sessionName}" not found. Please tell me which session you want to set as Alexa preset.`)
          .reprompt('Which session should I set as Alexa preset?')
          .getResponse();
      }
        
    } catch (error) {
      console.error('Error in SetAlexaPresetIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while setting Alexa preset session. Please try again.')
        .getResponse();
    }
  }
};

// Update CreateSessionIntentHandler to include preset option
const CreateSessionIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'CreateSessionIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    const setAsPreset = Alexa.getSlotValue(handlerInput.requestEnvelope, 'setAsPreset');
    const shouldSetAsPreset = setAsPreset === 'yes' || setAsPreset === 'true';
    
    const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
    sessionAttributes.inSessionCreation = true;
    sessionAttributes.sessionCreationStep = 'name';
    sessionAttributes.shouldSetAsPreset = shouldSetAsPreset;
    handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
    
    let speechText = 'Okay, let\'s create a new session. What would you like to name this session?';
    if (shouldSetAsPreset) {
      speechText += ' This session will be set as your Alexa preset.';
    }
    
    return handlerInput.responseBuilder
      .speak(speechText)
      .reprompt('What should I call this session?')
      .getResponse();
  }
};

// Update other intent handlers similarly...
// [Keep the rest of your intent handlers but ensure they're all async]

// Express setup with FIXED middleware
const app = express();
const adapter = new ExpressAdapter(skill, true, true);

// FIXED middleware with proper async/await
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

app.post('*', adapter.getRequestHandlers());

app.get('*', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Attendance Skill is running',
    timestamp: new Date().toISOString()
  });
});

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
    SetAlexaPresetIntentHandler, // NEW handler
    CreateSessionIntentHandler,
    // ... include all your other handlers
    HelpIntentHandler,
    CancelAndStopIntentHandler,
    FallbackIntentHandler,
    SessionEndedRequestHandler
  )
  .addErrorHandlers(ErrorHandler)
  .create();

module.exports = app;
