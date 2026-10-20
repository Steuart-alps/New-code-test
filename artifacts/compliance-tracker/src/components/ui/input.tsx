import * as React from "react"

import { cn } from "@/lib/utils"
import { DictationButton, dictationSupported, useMergedRef } from "@/components/dictation-button"

type InputProps = React.ComponentProps<"input"> & {
  /** Show the microphone button for speaking instead of typing (default off). */
  dictation?: boolean
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, dictation = false, ...props }, ref) => {
    const [innerRef, setRef] = useMergedRef(ref)
    const withMic = dictation && dictationSupported && (type === undefined || type === "text" || type === "search")
    const field = (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className,
          withMic && "pr-10"
        )}
        ref={setRef}
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
