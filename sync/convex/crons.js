import { cronJobs, makeFunctionReference } from 'convex/server';

// Keeps signInFailures and pairings from growing without bound; see auth:cleanupExpired.
const crons = cronJobs();
crons.hourly('drop expired sign-in failures and pairing codes', { minuteUTC: 7 }, makeFunctionReference('auth:cleanupExpired'));
export default crons;
