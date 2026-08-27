-- The built-in "Ask About Webpage" command's question token gains a name
-- ({argument name="question"}) so the capture flow labels the step "Enter
-- question…" instead of the generic "Enter argument…". Guarded on the
-- exact original seed text: a user-edited prompt is never overwritten.
UPDATE ai_commands
SET prompt = 'Given the following webpage content, answer the user''s question: {argument name="question"}

Webpage content:
{webpage}'
WHERE id = 'ai.command.builtin.ask-about-webpage'
  AND prompt = 'Given the following webpage content, answer the user''s question: {argument}

Webpage content:
{webpage}';
