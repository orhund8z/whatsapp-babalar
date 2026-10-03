# Learning: When to Use GPT-4o-mini vs. JEV

Short version:

- Use `gpt-4o-mini` when the system needs to understand, rewrite, summarize, or generate natural language.
- Use `JEV` when the system needs to make a narrow, typed decision: yes/no, one option from a fixed list, or a score on a predefined rubric.

JEV does not write user-facing answers. It decides things like: should this answer be shown, is this request out of scope, is there PII risk, or is the answer sufficiently grounded in the retrieved sources?

## When to Use GPT-4o-mini

### 1. Rewriting the User Question for Search

User asks:

```text
tuv icin ne lazimdi
```

GPT-4o-mini can normalize and rewrite it:

```json
{
  "corrected": "TUV icin ne lazimdi?",
  "search_query": "TUV icin gerekli belgeler"
}
```

This is not a good JEV task because it requires flexible language understanding and rewriting.

### 2. Generating an Answer from WhatsApp Messages

User asks:

```text
Is there a pediatrician recommendation in Munich?
```

The RAG pipeline retrieves relevant WhatsApp messages. GPT-4o-mini turns them into a Turkish answer:

```text
Toplulukta birkac cocuk doktoru ismi gecmis. Ahmet Bey, Dr. Muller'den memnun kaldigini soylemis. Baska bir mesajda randevu bulmanin zor oldugu belirtilmis...
```

This is GPT-4o-mini's job because it has to synthesize multiple messages, preserve nuance, mention conflicting experiences, and write a readable answer.

### 3. Flexible Categorization

Message:

```text
Where do you get car insurance?
```

GPT-4o-mini can classify it:

```json
["araba"]
```

This can work with GPT-4o-mini today. It could also move to JEV later because category selection is a narrow fixed-choice decision.

## When to Use JEV

### 1. Deciding Whether an Answer Should Be Shown

GPT-4o-mini generates:

```text
Toplulukta AOK, TK ve Barmer hakkinda konusulmus...
```

Ask JEV:

```text
Is this answer sufficiently supported by the provided WhatsApp sources?
```

Example JEV result:

```json
{
  "answer_grounded": 0.91
}
```

If the score is high, show the answer. If it is low, return a safer fallback:

```text
Bu konuda toplulukta yeterli dogrulanabilir bilgi bulamadim.
```

### 2. Detecting Out-of-Scope Requests

User asks:

```text
Should I buy Bitcoin?
```

Babalar is meant to answer from the Munich Turkish expat WhatsApp archive. Ask JEV:

```text
Is this request outside the assistant's scope?
```

Example JEV result:

```json
{
  "out_of_scope": 0.87
}
```

In this case, the backend can refuse or avoid running the full RAG flow.

### 3. Blocking PII or Sensitive Data

GPT-4o-mini generates an answer that includes:

```text
Mehmet'in telefonu 0176...
```

Ask JEV:

```text
Does this answer expose personal data?
```

Example JEV result:

```json
{
  "pii_risk": 0.94
}
```

The answer should not be shown. The app should return a safe message instead:

```text
Bu yanitta kisisel veri paylasma riski oldugu icin gosteremiyorum.
```

### 4. Choosing the Next Action

Ask JEV to choose one action:

```text
What should the app do with this answer?

Options:
- show: show it to the user
- show_with_caveat: show it with a warning
- reject: do not show it
- needs_review: require human review
```

Example JEV result:

```json
{
  "answer_action": "show_with_caveat",
  "confidence": 0.78
}
```

The backend can then act on the structured decision.

## Concrete Flow for This Repo

Example user question:

```text
Munich'te birth registration nasil yapiliyordu?
```

Ideal flow:

1. GPT-4o-mini corrects and rewrites the question.
2. Embeddings plus pgvector retrieve related WhatsApp messages.
3. GPT-4o-mini generates a Turkish answer from those messages.
4. JEV checks the result:
   - Is the answer grounded in the retrieved messages?
   - Does it contain PII?
   - Is the question out of scope?
   - Should the app show, caveat, reject, or review the answer?
5. The app returns the answer only if the decision layer allows it.

Another example:

```text
Can you find Ahmet's phone number?
```

JEV can decide early:

```json
{
  "pii_request": 0.96,
  "answer_action": "reject"
}
```

The app should answer:

```text
Kisisel telefon numarasi gibi ozel bilgileri paylasamam.
```

## Practical Rule

Use `gpt-4o-mini` when:

- A sentence needs to be written.
- A message needs to be understood or rewritten.
- A natural language answer must be synthesized from retrieved sources.
- Context is messy, ambiguous, or multilingual.

Use `JEV` when:

- The decision is yes/no.
- The answer must be one item from a fixed list.
- A risk, quality, confidence, or severity score is needed.
- The same decision must run cheaply and consistently for every answer.

For Babalar, GPT-4o-mini should remain the answer generator. JEV should sit around it as a typed decision and verification layer.
