
# Aggressive Overrides & AI Confidence Guardrails
When building or modifying "Aggressive", "Degen", or "Forced Trade" modes, NEVER allow these modes to unconditionally override AI confidence or anti-hallucination guardrails. If an AI explicitly reports critically low confidence (e.g., data unreadable, broken context), the system MUST abort the trade/action and fall back to a safe neutral state, regardless of any user-enabled "aggressive" settings. Aggressive settings should only force decisions in ambiguous (50-50) but valid data states, not in corrupted or unreadable data states.

# Max Entry Price & EV Guardrails (Anti-Overpaying Rule)
NEVER execute or recommend a trade (PLAY) if the binary outcome token price is overpriced relative to expected value or exceeds safe risk/reward boundaries (e.g. buying above 0.70-0.75). Even if directional prediction (UP/DOWN) is correct at resolution, overpaying for binary tokens creates severe asymmetric downside risk (-100% loss vs small upside gain) and negative expected value (EV). High entry prices (> 0.70) must be automatically filtered out to AVOID.
