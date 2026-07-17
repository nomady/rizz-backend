// security.js - IP & Security Helpers
const crypto = require('crypto');

// Get client IP from request
function getClientIP(req) {
    // Check for proxy headers
    const forwarded = req.headers['x-forwarded-for'];
    const realIp = req.headers['x-real-ip'];
    const cfConnectingIp = req.headers['cf-connecting-ip']; // Cloudflare
    
    if (cfConnectingIp) return cfConnectingIp;
    if (forwarded) return forwarded.split(',')[0].trim();
    if (realIp) return realIp;
    
    // Fallback to socket address
    return req.socket?.remoteAddress || req.ip || 'unknown';
}

// Get user agent
function getUserAgent(req) {
    return req.headers['user-agent'] || 'unknown';
}

// Hash IP for privacy (optional - for GDPR)
function hashIP(ip) {
    if (!ip || ip === 'unknown') return null;
    return crypto.createHash('sha256').update(ip + process.env.IP_SALT || 'salt').digest('hex');
}

// Check if IP is blocked (you can expand this)
function isIPBlocked(ip) {
    // Add your blocklist logic here
    const blockedIPs = process.env.BLOCKED_IPS?.split(',') || [];
    return blockedIPs.includes(ip);
}

// Log audit action
async function logAudit(supabase, userId, action, ip, userAgent, details = {}) {
    try {
        // Use service role for audit logs (bypass RLS)
        const { error } = await supabase
            .from('audit_logs')
            .insert({
                user_id: userId,
                action: action,
                ip_address: ip,
                user_agent: userAgent,
                details: details
            });
        
        if (error) {
            console.error('Failed to log audit:', error);
        }
    } catch (error) {
        console.error('Audit log error:', error);
    }
}

module.exports = {
    getClientIP,
    getUserAgent,
    hashIP,
    isIPBlocked,
    logAudit
};