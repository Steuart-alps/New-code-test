import * as React from "react"

import { cn } from "@/lib/utils"
import { DictationButton, dictationSupported, useMergedRef } from "@/components/dictation-button"

type TextareaProps = React.ComponentProps<"textarea"> & {
  /** Show the microphone button for speaking instead of typing (default on). */
  dictation?: boolean
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, dictation = true, ...props }, ref) => {
    const [innerRef, setRef] = useMergedRef(ref)
    const withMic = dictation && dictationSupported
    const field = (
      <textarea
        // Underline spelling mistakes (UK English, from <html lang="en-GB">).
        spellCheck
        className={cn(
          "flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className,
          withMic && "pr-10"
        )}
        ref={setRef}
        {...props}
      />
    )
    if (!withMic) return field
    // The wrapper stays even while the box is disabled, so the box itself is
    // never remounted (which would lose react-hook-form values).
    return (
      <div className="relative w-full" data-slot="dictation-field">
        {field}
        <DictationButton
          targetRef={innerRef}
          disabled={props.disabled || props.readOnly}
          className="absolute right-1.5 top-1.5"
        />
      </div>
    )
  }
)
Textarea.displayName = "Textarea"

export { Textarea }
