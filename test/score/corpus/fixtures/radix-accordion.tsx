// Original side of the radix-accordion fixture: the real Radix component, mounted
// in the browser so its keyboard behaviour is the reference.
import React from 'react';
import { createRoot } from 'react-dom/client';
import * as Accordion from '@radix-ui/react-accordion';

const ITEMS = [
  { value: 'one', title: 'Is it accessible?', body: 'Yes. It follows the pattern.' },
  { value: 'two', title: 'Is it styled?', body: 'Yes. With plain CSS here.' },
];

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="page" data-parity-id="page">
    <Accordion.Root type="single" collapsible data-parity-id="accordion">
      {ITEMS.map((item) => (
        <Accordion.Item key={item.value} value={item.value} className="accordion-item" data-parity-id={`item-${item.value}`}>
          <Accordion.Header className="accordion-heading" data-parity-id={`heading-${item.value}`}>
            <Accordion.Trigger className="accordion-trigger" data-parity-id={`trigger-${item.value}`}>
              {item.title}
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content className="accordion-content" data-parity-id={`content-${item.value}`}>
            {item.body}
          </Accordion.Content>
        </Accordion.Item>
      ))}
    </Accordion.Root>
  </div>,
);
