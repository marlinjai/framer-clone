"use client"

// A tooltip that a pointer and the keyboard both reach (Radix Tooltip opens on hover and on focus, closes on
// Escape, and ties its text to the trigger with aria-describedby). The editor's top bar uses it for the controls
// that fold into an icon, so what a control does is never said by a `title` alone.

import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

const InProvider = React.createContext(false)

/** Shares the hover delay among the tooltips inside it: from one to the next, the next shows at once. */
function TooltipProvider({ delayDuration = 300, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <InProvider.Provider value={true}>
      <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
    </InProvider.Provider>
  )
}

/** One tooltip. Outside a TooltipProvider it brings its own, so it works wherever it is placed. */
function Tooltip(props: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const root = <TooltipPrimitive.Root data-slot="tooltip" {...props} />
  return React.useContext(InProvider) ? root : <TooltipProvider>{root}</TooltipProvider>
}

function TooltipTrigger(props: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({ className, sideOffset = 6, children, ...props }: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        // Chrome for the drag resolver, like the menus: a drop over a tooltip is cancelled, never applied.
        data-editor-ui="true"
        sideOffset={sideOffset}
        className={cn(
          "bg-foreground text-background animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 motion-reduce:animate-none z-[1200] max-w-[20rem] rounded-md px-2.5 py-1.5 text-xs leading-snug text-balance shadow-md forced-colors:border",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
