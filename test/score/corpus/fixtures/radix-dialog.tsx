// Original side of the radix-dialog fixture: the real Radix component.
import React from 'react';
import { createRoot } from 'react-dom/client';
import * as Dialog from '@radix-ui/react-dialog';

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="page" data-parity-id="page">
    <Dialog.Root>
      <Dialog.Trigger className="dialog-trigger" data-parity-id="trigger">Edit profile</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" data-parity-id="overlay" />
        <Dialog.Content className="dialog-content" data-parity-id="content">
          <Dialog.Title className="dialog-title" data-parity-id="title">Edit profile</Dialog.Title>
          <Dialog.Description className="dialog-description" data-parity-id="description">Make changes here.</Dialog.Description>
          <Dialog.Close className="dialog-close" data-parity-id="close">Save</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>,
);
