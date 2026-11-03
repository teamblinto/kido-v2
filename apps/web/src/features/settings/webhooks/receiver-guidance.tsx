/**
 * Receiver guidance (FR-014), copied from contracts/webhook-delivery.md. The test vector is the one
 * `signature.spec.ts` pins in the API.
 */
const TEST_VECTOR = {
  body: '{"id":"00000000-0000-0000-0000-000000000000","type":"ping"}',
  secret: 'whsec_dGVzdC1zZWNyZXQtZm9yLWRvY3M',
  t: '1790000000',
  v1: 'f2e4f1f25d93fe6ef14e719bdfba115887323d2217a282dadcb8dfc158463d27',
} as const;

const STEPS = [
  'Read the raw body before any JSON parsing.',
  'Split the Forge-Signature header on ",". Take t, and every v1.',
  'Recompute the HMAC with your secret and compare against each v1 in constant time. Accept if any matches.',
  'Reject when the difference between now and t is more than 300 seconds.',
  'Deduplicate by Forge-Event-Id. Delivery is at least once, and order is not guaranteed.',
  'Answer 2xx within 10 seconds. Do slow work after answering.',
] as const;

export function ReceiverGuidance(): React.JSX.Element {
  return (
    <section className="border-line mt-6 rounded-lg border p-4" aria-labelledby="receiver-heading">
      <h2 id="receiver-heading" className="text-heading-sm font-semibold">
        Verifying a request
      </h2>
      <ol
        aria-label="Verifying a request"
        className="text-body-sm mt-2 list-decimal space-y-1 pl-5"
      >
        {STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <h3 className="text-label-sm mt-4 font-semibold">Test vector</h3>
      <dl className="text-body-sm mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-subdued">Secret</dt>
        <dd className="font-mono break-all">{TEST_VECTOR.secret}</dd>
        <dt className="text-subdued">t</dt>
        <dd className="font-mono">{TEST_VECTOR.t}</dd>
        <dt className="text-subdued">Body</dt>
        <dd className="font-mono break-all">{TEST_VECTOR.body}</dd>
        <dt className="text-subdued">Expected v1</dt>
        <dd className="font-mono break-all">{TEST_VECTOR.v1}</dd>
      </dl>
    </section>
  );
}
