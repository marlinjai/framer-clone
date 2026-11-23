'use client';
// src/app/projects/Greeting.tsx: "Good morning" and friends, from the visitor's own clock.
// The server does not know the visitor's time zone, so the first render says
// "Welcome back" and the browser swaps in the time of day once it is running.
import React, { useEffect, useState } from 'react';

export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function Greeting({ className }: { className?: string }) {
  const [text, setText] = useState('Welcome back');
  useEffect(() => setText(greetingFor(new Date().getHours())), []);
  return <p className={className}>{text}</p>;
}
