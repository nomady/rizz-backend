// server.js - GROQ + SUPABASE with Security
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');

// ===== GROQ IMPORT =====
const Groq = require('groq-sdk');

// ===== SUPABASE IMPORT =====
const { supabase, supabaseAdmin } = require('./supabase');

// ===== SECURITY HELPERS =====
const { getClientIP, getUserAgent, isIPBlocked, logAudit } = require('./security');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CORS CONFIGURATION =====
app.use(cors({
    origin: [
        'http://localhost:3000',
        'http://localhost:5500',
        'http://localhost:8000',
        'http://127.0.0.1:5500',
        'http://127.0.0.1:8000',
        'http://localhost:3001',
        'http://127.0.0.1:3000'
    ],
    credentials: true,
    optionsSuccessStatus: 200,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
}));

// ===== OTHER MIDDLEWARE =====
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(compression());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ===== IP BLOCKING MIDDLEWARE =====
app.use((req, res, next) => {
    const ip = getClientIP(req);
    if (isIPBlocked(ip)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    next();
});

// ===== RATE LIMITING (PER IP) =====
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
    keyGenerator: (req) => {
        return getClientIP(req); // Rate limit by IP
    },
    message: {
        error: 'Too many requests',
        message: 'Please slow down and try again in a minute.'
    },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api', limiter);

// ===== CACHE =====
const cache = new NodeCache({
    stdTTL: parseInt(process.env.CACHE_TTL_SECONDS) || 3600,
    checkperiod: 120,
});

// ===== GROQ INITIALIZATION =====
console.log('🔑 Checking Groq API key...');

if (!process.env.GROQ_API_KEY) {
    console.error('❌ GROQ_API_KEY is missing in .env file!');
    console.error('Get one at: https://console.groq.com/keys');
    process.exit(1);
}

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
console.log(`🚀 Initializing Groq with model: ${GROQ_MODEL}`);

// Test Groq connection
async function testGroqConnection() {
    try {
        const response = await groq.chat.completions.create({
            model: GROQ_MODEL,
            messages: [{ role: 'user', content: 'Say "OK"' }],
            max_tokens: 5,
        });
        console.log('✅ Groq connection successful!');
        return true;
    } catch (error) {
        console.error('❌ Groq connection failed:', error.message);
        return false;
    }
}
testGroqConnection();

// ===== SUPABASE HELPER FUNCTIONS =====

// Get user credits
async function getUserCredits(userId) {
    const { data, error } = await supabase
        .rpc('get_user_credits', { user_id: userId });
    
    if (error) {
        console.error('Error getting credits:', error);
        return 42;
    }
    return data || 42;
}

// Update user credits
async function updateUserCredits(userId, amount, type, description = '', ip = null) {
    const { data, error } = await supabase
        .rpc('update_user_credits', {
            user_id: userId,
            amount: amount,
            transaction_type: type,
            transaction_description: description
        });
    
    if (error) {
        console.error('Error updating credits:', error);
        return null;
    }
    
    // Log credit change
    await logAudit(supabase, userId, 'credit_update', ip, null, {
        amount,
        type,
        description,
        new_balance: data
    });
    
    return data;
}

// Save rizz history
async function saveRizzHistory(userId, message, response, tone, language = 'auto', ip = null) {
    const { error } = await supabase
        .from('rizz_history')
        .insert({
            user_id: userId,
            message,
            response,
            tone,
            language
        });
    
    if (error) {
        console.error('Error saving history:', error);
    }
    
    // Log the interaction
    await logAudit(supabase, userId, 'rizz_generate', ip, null, {
        message_length: message.length,
        response_length: response.length,
        tone,
        language
    });
}

// Get rizz history
async function getRizzHistory(userId, limit = 10) {
    const { data, error } = await supabase
        .from('rizz_history')
        .select('message, response, tone, language, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);
    
    if (error) {
        console.error('Error getting history:', error);
        return [];
    }
    return data;
}

// ===== MIDDLEWARE: Authenticate User =====
async function authenticateUser(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }
    
    const token = authHeader.split(' ')[1];
    
    // Verify token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
    
    req.user = user;
    req.ip = getClientIP(req);
    req.userAgent = getUserAgent(req);
    next();
}

// ===== PROMPT ENGINEERING =====
const RIZZ_PROMPTS = {
    smooth: `You're a naturally smooth person with great social skills. You match the energy of what the person said.

⚠️ CRITICAL: Detect what language the message is in and reply in THAT EXACT SAME LANGUAGE.
If they write in Serbian, reply in Serbian.
If they write in English, reply in English.
Match their language perfectly.

Rules for your response:
- Use their tone and vibe as a guide
- Respond like you're texting a crush
- Use casual, modern language (texting style)
- Throw in emojis naturally 😏✨
- Be playful and confident
- Keep it short and punchy
- Don't overthink it - be natural

Now respond to: "{{message}}"`,

    funny: `You're hilarious and quick-witted. You make people laugh without trying too hard.

⚠️ CRITICAL: Detect what language the message is in and reply in THAT EXACT SAME LANGUAGE.
If they write in Serbian, reply in Serbian.
If they write in English, reply in English.
Match their language perfectly.

Rules for your response:
- Use playful sarcasm (but not mean)
- Light teasing is encouraged
- Match their energy - if they're joking, joke back
- Use casual text language
- Keep it short and punchy
- One-liners work great

Now respond to: "{{message}}"`,

    direct: `You're confident and straightforward. You say what you mean without playing games.

⚠️ CRITICAL: Detect what language the message is in and reply in THAT EXACT SAME LANGUAGE.
If they write in Serbian, reply in Serbian.
If they write in English, reply in English.
Match their language perfectly.

Rules for your response:
- Be direct but not aggressive
- Show clear interest without being desperate
- Use simple, bold language
- Keep it short (1 sentence max)
- Confidence is key
- No pickup lines - just honesty

Now respond to: "{{message}}"`
};

// ===== HELPER FUNCTIONS =====
function getCacheKey(message, context, tone, userId) {
    return `rizz:${userId}:${tone}:${message}:${context || 'no-context'}`;
}

function validateRequest(body) {
    const { message, tone } = body;
    
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return { valid: false, error: 'Message is required' };
    }
    
    if (message.length > 500) {
        return { valid: false, error: 'Message too long (max 500 characters)' };
    }
    
    const validTones = ['smooth', 'funny', 'direct'];
    if (tone && !validTones.includes(tone)) {
        return { valid: false, error: 'Invalid tone. Use: smooth, funny, or direct' };
    }
    
    return { valid: true };
}

// ===== GROQ HELPER =====
async function getGroqResponse(systemPrompt, userPrompt) {
    try {
        const response = await groq.chat.completions.create({
            model: GROQ_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: parseFloat(process.env.AI_TEMPERATURE) || 0.85,
            max_tokens: parseInt(process.env.AI_MAX_TOKENS) || 150,
        });
        
        return response.choices[0].message.content.trim();
        
    } catch (error) {
        console.error('❌ Groq API Error:', error);
        throw error;
    }
}

// ============================================
// ===== AUTH ROUTES =====
// ============================================

/**
 * POST /api/auth/signup
 * Sign up new user with auto-profile creation
 */
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { email, password, username, displayName } = req.body;
        const ip = getClientIP(req);
        const userAgent = getUserAgent(req);
        
        if (!email || !password || !username) {
            return res.status(400).json({ 
                error: 'Email, password, and username are required' 
            });
        }
        
        // Sign up with Supabase
        const { data: authData, error: signUpError } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: {
                    username: username,
                    display_name: displayName || username,
                }
            }
        });
        
        if (signUpError) {
            // Log failed attempt
            await logAudit(supabase, null, 'signup_failed', ip, userAgent, {
                email,
                reason: signUpError.message
            });
            return res.status(400).json({ error: signUpError.message });
        }
        
        const userId = authData.user.id;
        
        // Create profile with retry logic
        let profileCreated = false;
        let retries = 0;
        
        while (!profileCreated && retries < 3) {
            try {
                const { error: profileError } = await supabase
                    .from('profiles')
                    .insert({
                        id: userId,
                        username: username,
                        display_name: displayName || username,
                        credits: parseInt(process.env.INITIAL_CREDITS) || 42,
                        last_ip: ip,
                        last_user_agent: userAgent,
                        last_login_at: new Date().toISOString(),
                        login_count: 1
                    });
                
                if (profileError) {
                    console.error('Profile creation attempt', retries + 1, 'failed:', profileError);
                    retries++;
                    if (retries < 3) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                        continue;
                    }
                    throw profileError;
                }
                
                profileCreated = true;
                console.log('✅ Profile created successfully for user:', userId);
                
            } catch (error) {
                console.error('Profile creation error:', error);
                if (retries >= 2) {
                    // Last resort: try with service role
                    const { error: serviceError } = await supabaseAdmin
                        .from('profiles')
                        .insert({
                            id: userId,
                            username: username,
                            display_name: displayName || username,
                            credits: parseInt(process.env.INITIAL_CREDITS) || 42,
                            last_ip: ip,
                            last_user_agent: userAgent,
                            last_login_at: new Date().toISOString(),
                            login_count: 1
                        });
                    
                    if (!serviceError) {
                        profileCreated = true;
                        console.log('✅ Profile created with service role');
                    }
                }
                retries++;
            }
        }
        
        // Log signup
        await logAudit(supabase, userId, 'signup', ip, userAgent, {
            username,
            email
        });
        
        res.json({
            success: true,
            user: authData.user,
            message: 'Account created successfully!'
        });
        
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/auth/login
 * Login user
 */
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const ip = getClientIP(req);
        const userAgent = getUserAgent(req);
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }
        
        // Sign in with Supabase
        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password,
        });
        
        if (error) {
            // Log failed login
            await logAudit(supabase, null, 'login_failed', ip, userAgent, {
                email,
                reason: error.message
            });
            return res.status(401).json({ error: error.message });
        }
        
        const userId = data.user.id;
        
        // Make sure profile exists
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();
        
        // If profile doesn't exist, create it
        if (profileError && profileError.code === 'PGRST116') {
            console.log('Profile missing, creating for user:', userId);
            await supabase
                .from('profiles')
                .insert({
                    id: userId,
                    username: data.user.email.split('@')[0],
                    display_name: data.user.email.split('@')[0],
                    credits: parseInt(process.env.INITIAL_CREDITS) || 42,
                    last_ip: ip,
                    last_user_agent: userAgent,
                    last_login_at: new Date().toISOString(),
                    login_count: 1
                });
        } else {
            // Update profile with login info
            await supabase.rpc('update_profile_on_login', {
                user_id: userId,
                ip_address: ip,
                user_agent: userAgent
            });
        }
        
        // Log successful login
        await logAudit(supabase, userId, 'login', ip, userAgent, {
            email
        });
        
        // Get user credits
        const credits = await getUserCredits(userId);
        
        res.json({
            success: true,
            user: data.user,
            session: data.session,
            credits
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/auth/logout
 * Logout user
 */
app.post('/api/auth/logout', authenticateUser, async (req, res) => {
    try {
        const { error } = await supabase.auth.signOut();
        
        if (error) {
            return res.status(400).json({ error: error.message });
        }
        
        // Log logout
        await logAudit(supabase, req.user.id, 'logout', req.ip, req.userAgent);
        
        res.json({ success: true, message: 'Logged out successfully' });
        
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/auth/me
 * Get current user info
 */
app.get('/api/auth/me', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Get profile
        const { data: profile, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();
        
        if (error) {
            return res.status(400).json({ error: error.message });
        }
        
        // Get credits
        const credits = await getUserCredits(userId);
        
        res.json({
            user: {
                id: userId,
                email: req.user.email,
                ...profile,
                credits
            }
        });
        
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/auth/audit
 * Get user's audit logs (security)
 */
app.get('/api/auth/audit', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = parseInt(req.query.limit) || 50;
        
        const { data, error } = await supabase
            .rpc('get_user_audit_logs', {
                user_id: userId,
                limit_count: limit
            });
        
        if (error) {
            return res.status(400).json({ error: error.message });
        }
        
        res.json({
            logs: data,
            count: data.length
        });
        
    } catch (error) {
        console.error('Get audit error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// ===== API ROUTES =====
// ============================================

/**
 * GET /api/health
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        provider: 'groq',
        model: GROQ_MODEL,
        database: 'supabase',
        security: {
            ip_tracking: true,
            audit_logging: true,
            rate_limiting: true
        }
    });
});

/**
 * GET /api/credits
 * Get user's credit balance (authenticated)
 */
app.get('/api/credits', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const credits = await getUserCredits(userId);
        
        res.json({
            userId,
            credits,
            initialCredits: parseInt(process.env.INITIAL_CREDITS) || 42
        });
        
    } catch (error) {
        console.error('Get credits error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/credits/add
 * Add credits (admin/testing)
 */
app.post('/api/credits/add', authenticateUser, async (req, res) => {
    try {
        const { amount = 10 } = req.body;
        const userId = req.user.id;
        
        if (amount < 0 || amount > 100) {
            return res.status(400).json({ error: 'Amount must be between 0 and 100' });
        }
        
        const newBalance = await updateUserCredits(
            userId, 
            amount, 
            'bonus', 
            'Testing bonus',
            req.ip
        );
        
        res.json({
            userId,
            creditsAdded: amount,
            newBalance
        });
        
    } catch (error) {
        console.error('Add credits error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/rizz
 * Main endpoint - get rizz response
 */
app.post('/api/rizz', authenticateUser, async (req, res) => {
    try {
        const { message, context, tone = 'smooth' } = req.body;
        const userId = req.user.id;
        const ip = req.ip;
        
        console.log(`📝 Request from ${userId} (${ip}): "${message}" (${tone})`);
        
        // 1. Validate request
        const validation = validateRequest(req.body);
        if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
        }
        
        // 2. Check credits
        const currentCredits = await getUserCredits(userId);
        if (currentCredits < 1) {
            return res.status(402).json({
                error: 'Insufficient credits',
                message: 'Please purchase more credits to continue.',
                credits: currentCredits
            });
        }
        
        // 3. Check cache
        const cacheKey = getCacheKey(message, context, tone, userId);
        if (process.env.ENABLE_CACHE === 'true') {
            const cachedResponse = cache.get(cacheKey);
            if (cachedResponse) {
                console.log('⚡ Cache hit!');
                return res.json({
                    rizz: cachedResponse,
                    tone,
                    credits: currentCredits,
                    cached: true,
                    provider: 'groq'
                });
            }
        }
        
        // 4. Deduct credit
        const newBalance = await updateUserCredits(
            userId, 
            -1, 
            'use', 
            `Rizz request: "${message}"`,
            ip
        );
        
        // 5. Build prompt
        const systemPrompt = RIZZ_PROMPTS[tone] || RIZZ_PROMPTS.smooth;
        const userPrompt = context 
            ? `Context: ${context}\nPerson said: "${message}"\n\nGive me the best rizz response.`
            : `Person said: "${message}"\n\nGive me the best rizz response.`;
        
        // 6. Call Groq
        const rizzResponse = await getGroqResponse(systemPrompt, userPrompt);
        
        // 7. Save to history with IP
        await saveRizzHistory(userId, message, rizzResponse, tone, 'auto', ip);
        
        // 8. Cache response
        if (process.env.ENABLE_CACHE === 'true') {
            cache.set(cacheKey, rizzResponse);
        }
        
        // 9. Return response
        res.json({
            rizz: rizzResponse,
            tone,
            credits: newBalance || currentCredits - 1,
            cached: false,
            provider: 'groq',
            security: {
                request_id: crypto.randomUUID()
            }
        });
        
    } catch (error) {
        console.error('❌ Groq API Error:', error);
        
        // Handle specific errors
        if (error.message?.includes('429') || error.status === 429) {
            return res.status(429).json({
                error: 'Rate limit exceeded',
                message: 'Groq free tier limit: 30 requests per minute. Please wait a moment.'
            });
        }
        
        if (error.message?.includes('API key') || error.message?.includes('auth')) {
            return res.status(500).json({
                error: 'API configuration error',
                message: 'Please check your Groq API key in .env file.'
            });
        }
        
        // Generic error
        res.status(500).json({
            error: 'Internal server error',
            message: error.message || 'Something went wrong. Please try again.'
        });
    }
});

// ... [rest of your routes remain the same]

// ===== START SERVER =====
app.listen(PORT, () => {
    console.log(`\n🚀 Rizz AI Backend running on http://localhost:${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
    console.log(`⚡ Using Groq AI with model: ${GROQ_MODEL}`);
    console.log(`🗄️  Using Supabase database`);
    console.log(`🛡️  Security: IP tracking, audit logging, rate limiting`);
    console.log(`🌐 Allowed CORS origins: localhost:3000, 5500, 8000`);
    console.log(`\n💡 Groq Free Tier: 30 requests/min`);
});