// src/lib/forms/unavailable.ts
//
// Where a form cannot be sent: a branch's public preview (site branches, slice
// S8). The value is the sentence the form shows instead of sending; null
// everywhere else. The checkout has the same kind of context
// (CheckoutUnavailableContext in src/lib/commerce/cart.tsx).

import { createContext } from 'react';

export const FormUnavailableContext = createContext<string | null>(null);
FormUnavailableContext.displayName = 'FormUnavailableContext';
