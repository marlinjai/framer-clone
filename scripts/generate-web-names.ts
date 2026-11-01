// pnpm generate:web-names: writes the names the panel's Custom section suggests.
// See test/score/lib/webPlatformNames.ts.

import fs from 'node:fs';
import { webPlatformNamesSource } from '../test/score/lib/webPlatformNames';

fs.writeFileSync('src/lib/styles/webPlatformNames.generated.ts', webPlatformNamesSource());
