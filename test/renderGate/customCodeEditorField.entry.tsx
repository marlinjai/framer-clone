// The page side of customCodeEditorField.gate.ts: the Custom code section's real field
// component (src/components/customCode/CustomCodeEditor.tsx) in React, the plain field first
// and CodeMirror once its chunk is in, with its title changeable from the page.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { CustomCodeEditor } from '@/components/customCode/CustomCodeEditor';

interface GateWindow {
  __rename(title: string): void;
  __value(): string;
}

const w = window as unknown as GateWindow;

function Field() {
  const [title, setTitle] = React.useState('');
  const [value, setValue] = React.useState('<p>one</p>');
  w.__rename = setTitle;
  w.__value = () => value;
  return <CustomCodeEditor id="field" value={value} onChange={setValue} label={`Code of ${title.trim() || 'this block'}`} />;
}

createRoot(document.getElementById('root')!).render(<Field />);
// ci-replay touch
