import assert from "node:assert/strict";
import { convertRequestBody, convertResponseBody } from "../src/openai-protocol.js";

const responsesRequest = convertRequestBody({
  model: "client-model",
  messages: [{ role: "user", content: "hello" }],
  max_tokens: 20,
}, "chat-completions", "responses", "vendor-model");
assert.equal(responsesRequest.model, "vendor-model");
assert.deepEqual(responsesRequest.input, [{ role: "user", content: "hello" }]);
assert.equal(responsesRequest.max_output_tokens, 20);
assert.equal(responsesRequest.messages, undefined);

const chatRequest = convertRequestBody({
  model: "client-model",
  instructions: "be concise",
  input: "hello",
}, "responses", "chat-completions", "vendor-model");
assert.deepEqual(chatRequest.messages, [
  { role: "system", content: "be concise" },
  { role: "user", content: "hello" },
]);

const multimodalRequest = convertRequestBody({
  input: [{
    role: "user",
    content: [
      { type: "input_text", text: "describe" },
      { type: "input_image", image_url: "data:image/png;base64,abc" },
    ],
  }],
}, "responses", "chat-completions", "vendor-model");
assert.deepEqual(multimodalRequest.messages[0].content, [
  { type: "text", text: "describe" },
  { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
]);

const responsesBody = convertResponseBody({
  id: "chat-1",
  object: "chat.completion",
  created: 10,
  model: "vendor-model",
  choices: [{ message: { role: "assistant", content: "answer" } }],
}, "chat-completions", "responses");
assert.equal(responsesBody.object, "response");
assert.equal(responsesBody.output[0].content[0].text, "answer");

const chatBody = convertResponseBody({
  id: "resp-1",
  object: "response",
  created_at: 10,
  model: "vendor-model",
  output: [{ type: "message", content: [{ type: "output_text", text: "answer" }] }],
}, "responses", "chat-completions");
assert.equal(chatBody.object, "chat.completion");
assert.equal(chatBody.choices[0].message.content, "answer");

assert.throws(
  () => convertRequestBody({ stream: true, messages: [] }, "chat-completions", "responses", "vendor-model"),
  (error) => error.statusCode === 400 && error.errorType === "unsupported_stream_conversion",
);
assert.throws(
  () => convertRequestBody({ input: [{ content: [{ type: "input_file" }] }] }, "responses", "chat-completions", "vendor-model"),
  (error) => error.statusCode === 400 && error.errorType === "unsupported_content",
);

console.log("OpenAI protocol tests passed");
