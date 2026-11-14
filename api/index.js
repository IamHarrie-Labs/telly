// Vercel entry point. Static files in public/ are served by Vercel's CDN; every other path
// (/auth/*, /callback, /api/*) is rewritten here by vercel.json.
import { app } from '../lib/app.js';

export default app;
