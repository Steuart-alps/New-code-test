import * as React from "react"

import { cn } from "@/lib/utils"
import { DictationButton, dictationSupported, useMergedRef } from "@/components/dictation-button"

type InputProps = React.ComponentProps<"input"> & {
  /** Show the microphone button for speaking instead of typing (default off). */
  dictation?: boolean
  /** Select the whole value when the box is entered, so typing replaces a pre-filled default. */
  selectOnFocus?: boolean
}

const NOT_WORDS = new Set(["numeric", "decimal", "tel", "email", "url"])

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, dictation = false, selectOnFocus = false, onFocus, onMouseDown, onMouseUp, ...props }, ref) => {
    const clickToFocus = React.useRef(false)
    const [innerRef, setRef] = useMergedRef(ref)
    const isTextBox = type === undefined || type === "text" || type === "search"
    const withMic = dictation && dictationSupported && isTextBox
    const field = (
      <input
        type={type}
        // Underline spelling mistakes (UK English, from <html lang="en-GB">).
        // Firefox only checks multi-line boxes unless asked; number-style
        // boxes are left alone, and spellCheck={false} turns it off for codes.
        spellCheck={isTextBox && !NOT_WORDS.has(props.inputMode ?? "") ? true : undefined}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className,
          withMic && "pr-10"
        )}
        ref={setRef}
        onFocus={(event) => {
          onFocus?.(event)
          if (selectOnFocus) event.currentTarget.select()
        }}
        onMouseDown={(event) => {
          onMouseDown?.(event)
          clickToFocus.current = selectOnFocus && document.activeElement !== event.currentTarget
        }}
        onMouseUp={(event) => {
          onMouseUp?.(event)
          // Some browsers (Safari) place the caret when the click that
          // focused the box ends, undoing the selection; a later click edits.
          if (clickToFocus.current) event.preventDefault()
          clickToFocus.current = false
        }}
        {...props}
      />
    )
    if (!withMic) return field
    return (
      <div className="relative w-full" data-slot="dictation-field">
        {field}
        <DictationButton
          targetRef={innerRef}
          disabled={props.disabled || props.readOnly}
          singleLine
          className="absolute right-1 top-1/2 -translate-y-1/2"
        />
      </div>
    )
  }
)
Input.displayName = "Input"

export { Input }
