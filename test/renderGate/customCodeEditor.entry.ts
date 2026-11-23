// The page side of the custom code editor gate (customCodeEditor.gate.ts): the real
// CodeMirror field of the Custom code section (src/components/customCode/codeMirrorView.ts),
// bundled by the gate with esbuild, between two plain buttons so Tab has somewhere to go.

import { mountCodeMirror, type CodeMirrorHandle } from '@/components/customCode/codeMirrorView';

interface GateWindow {
  /** Set by the page before this script: mount the field read-only, as a reader gets it. */
  __readOnly?: boolean;
  __changes: string[];
  __handle: CodeMirrorHandle;
}

const w = window as unknown as GateWindow;
w.__changes = [];
const host = document.getElementById('editor')!;
w.__handle = mountCodeMirror(host, {
  value: '<p>one</p>',
  onChange: (value) => w.__changes.push(value),
  label: 'Code of Clock',
  describedBy: 'hint',
  readOnly: w.__readOnly === true,
});
