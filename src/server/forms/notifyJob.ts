import 'server-only';

// src/server/forms/notifyJob.ts
//
// Sending the site owner's notice as a job (src/server/forms/notify.ts): one `form_mail` job per submission and
// round, written with its row in the submission's own transaction. The payload is the submission id, nothing more.
// The retry policy is the buyer's letter's (mail/mailJob.ts): 1, 5, 15 and 60 minutes, then every 6 hours, for three
// days. A submission deleted while a retry is pending ends the job quietly (`none`).

import { z } from 'zod';

import { defineJobKind } from '@/server/commerce/jobs/types';
import { GIVE_UP_AFTER_MS } from '@/server/commerce/mail/outbox';
import { FORM_MAIL_JOB_KIND } from './notify';

export { FORM_MAIL_JOB_KIND };

const HOUR_MS = 60 * 60 * 1000;

export const formMailKind = defineJobKind({
  policy: {
    // One call to Lumitra Mail takes at most its own 10 second timeout, twice; a first notice also installs templates.
    deadlineMs: 90 * 1000,
    backoffMinutes: [1, 5, 15, 60],
    laterMinutes: 6 * 60,
    // The attempt itself writes `failed` after three days; this only has to come after it.
    giveUpAfterMs: GIVE_UP_AFTER_MS + HOUR_MS,
  },
  payload: z.object({ submissionId: z.string().min(1).max(200) }).strict(),
  async run({ mail, payload: { submissionId } }) {
    await mail.deliverFormNotification(submissionId);
  },
});
