import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/hooks/use-toast";
import {
  dictationErrorMessage,
  dictationLanguage,
  getSpeechRecognition,
  listensContinuously,
  type SpeechRecognitionLike,
} from "@/lib/dictation";

// Only one microphone listens at a time: starting another stops this one.
let stopActive: (() => void) | null = null;

/**
 * Listen with the browser's built-in speech recognition and hand each
 * finished phrase to `onText`. `interim` holds the words still being heard.
 */
export function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const stopThisRef = useRef<(() => void) | null>(null);
  // Words heard but not yet final: Safari can stop without finalising them.
  const pendingRef = useRef("");
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Recognition = getSpeechRecognition();
    if (!Recognition || recognitionRef.current) return;
    stopActive?.();

    const recognition = new Recognition();
    recognition.lang = dictationLanguage();
    // Chrome on Android and Safari (on iPhone, iPad and Mac) repeat earlier
    // words in continuous mode, so there it listens to one phrase per tap.
    recognition.continuous = listensContinuously(navigator.userAgent, navigator.maxTouchPoints);
    pendingRef.current = "";
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let pending = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) onTextRef.current(transcript);
        else pending += transcript;
      }
      pendingRef.current = pending.trim();
      setInterim(pending.trim());
    };
    recognition.onerror = (event) => {
      const message = dictationErrorMessage(event.error);
      if (message) toast({ title: "Dictation stopped", description: message, variant: "destructive" });
    };
    recognition.onend = () => {
      const unfinished = pendingRef.current;
      pendingRef.current = "";
      recognitionRef.current = null;
      if (stopActive === stopThis) stopActive = null;
      setListening(false);
      setInterim("");
      // Keep words Safari heard but stopped before finalising.
      if (unfinished) onTextRef.current(unfinished);
    };
    const stopThis = () => recognition.stop();
    stopThisRef.current = stopThis;

    try {
      recognition.start();
    } catch {
      return;
    }
    recognitionRef.current = recognition;
    stopActive = stopThis;
    setListening(true);
  }, []);

  const toggle = useCallback(() => {
    if (recognitionRef.current) stop();
    else start();
  }, [start, stop]);

  // Closing a form mid-sentence stops listening without saving more words.
  useEffect(() => () => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onend = null;
    recognition.abort();
    recognitionRef.current = null;
    if (stopActive === stopThisRef.current) stopActive = null;
  }, []);

  return { listening, interim, start, stop, toggle };
}
