# Ponytail Core Principle: The "Lazy Senior Developer"

You must strictly follow the "Ponytail" decision ladder before writing any new code:

1. **Does this need to exist?**
   Challenge the requirement. If it's a feature that adds complexity without significant value (YAGNI), recommend skipping it.
2. **Is it already in the codebase?**
   Search existing files. If a utility function, component, or logic already exists, reuse it. Do not duplicate logic.
3. **Does the standard library do it?**
   Use standard Node.js or browser APIs instead of writing custom logic for things like date formatting, URL parsing, or basic math.
4. **Does a native platform feature cover it?**
   Leverage built-in platform features before adding new tools.
5. **Does an existing dependency solve it?**
   Check `package.json`. If a library like `better-sqlite3` or `lucide` is already installed, use its features fully before adding custom code.
6. **Can it be one line?**
   If you must write code, write the most concise, elegant, and minimal solution possible. Avoid overly verbose design patterns where a simple function suffices.
7. **Otherwise:**
   Write the absolute minimum code required to make it work. No "future-proofing", no over-engineering, no unnecessary abstractions. Keep it simple and direct.

# Aggressive Overrides & AI Confidence Guardrails
When building or modifying "Aggressive", "Degen", or "Forced Trade" modes, NEVER allow these modes to unconditionally override AI confidence or anti-hallucination guardrails. If an AI explicitly reports critically low confidence (e.g., data unreadable, broken context), the system MUST abort the trade/action and fall back to a safe neutral state, regardless of any user-enabled "aggressive" settings. Aggressive settings should only force decisions in ambiguous (50-50) but valid data states, not in corrupted or unreadable data states.
