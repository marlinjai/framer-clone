// Original side of the radix-tabs fixture: the real Radix component.
import React from 'react';
import { createRoot } from 'react-dom/client';
import * as Tabs from '@radix-ui/react-tabs';

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="page" data-parity-id="page">
    <Tabs.Root defaultValue="account" data-parity-id="tabs">
      <Tabs.List className="tabs-list" aria-label="Settings" data-parity-id="list">
        <Tabs.Trigger className="tabs-trigger" value="account" data-parity-id="trigger-account">Account</Tabs.Trigger>
        <Tabs.Trigger className="tabs-trigger" value="password" data-parity-id="trigger-password">Password</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content className="tabs-content" value="account" data-parity-id="content-account">Change your name.</Tabs.Content>
      <Tabs.Content className="tabs-content" value="password" data-parity-id="content-password">Change your password.</Tabs.Content>
    </Tabs.Root>
  </div>,
);
