
# Aggressive Overrides & AI Confidence Guardrails
When building or modifying "Aggressive", "Degen", or "Forced Trade" modes, NEVER allow these modes to unconditionally override AI confidence or anti-hallucination guardrails. If an AI explicitly reports critically low confidence (e.g., data unreadable, broken context), the system MUST abort the trade/action and fall back to a safe neutral state, regardless of any user-enabled "aggressive" settings. Aggressive settings should only force decisions in ambiguous (50-50) but valid data states, not in corrupted or unreadable data states.
