import * as Sentry from '@sentry/nestjs';
import { capitalize } from 'lodash';

export const initializeSentry = (appName: string, allowLogs = false) => {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) {
    return null;
  }

  try {
    Sentry.init({
      initialScope: {
        tags: {
          service: appName,
          component: 'nestjs',
        },
        contexts: {
          app: {
            name: `Postiz ${capitalize(appName)}`,
          },
        },
      },
      environment: process.env.NODE_ENV || 'development',
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      spotlight: process.env.SENTRY_SPOTLIGHT === '1',
      integrations: [
        // Profiling is enabled by default in production.
        // It is disabled by default in development to avoid native library issues
        // (e.g. GLIBCXX version errors on older Linux systems).
        // You can force it on/off using SENTRY_ENABLE_PROFILING=true/false
        ...((process.env.SENTRY_ENABLE_PROFILING
          ? process.env.SENTRY_ENABLE_PROFILING === 'true'
          : process.env.NODE_ENV !== 'development')
          ? [require('@sentry/profiling-node').nodeProfilingIntegration()]
          : []),
        Sentry.consoleLoggingIntegration({ levels: ['log', 'info', 'warn', 'error', 'debug', 'assert', 'trace'] }),
        Sentry.openAIIntegration({
          recordInputs: true,
          recordOutputs: true,
        }),
      ],
      tracesSampleRate: 1.0,
      enableLogs: true,

      // Profiling
      profileSessionSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.45,
      profileLifecycle: 'trace',
    });
  } catch (err) {
    console.log(err);
  }
  return true;
};
