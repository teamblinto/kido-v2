import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PresenceStrip } from './presence-strip';

const BOB = {
  email: 'bob@example.com',
  location: { path: 'src/a.ts', view: 'code' as const },
  seenAt: '2026-09-23T10:00:00.000Z',
  userId: '11111111-1111-4111-8111-111111111111',
};
const CY = {
  email: 'cy@example.com',
  location: { view: 'preview' as const },
  seenAt: '2026-09-23T10:00:00.000Z',
  userId: '22222222-2222-4222-8222-222222222222',
};

describe('PresenceStrip', () => {
  it('shows each other person once with their location', () => {
    render(<PresenceStrip presence={{ available: true, people: [BOB, CY] }} />);

    const markers = screen.getAllByRole('listitem');

    expect(markers).toHaveLength(2);
    expect(markers[0]).toHaveTextContent('B');
    expect(markers[0]).toHaveAccessibleName('bob@example.com — Code: src/a.ts');
    expect(markers[1]).toHaveAccessibleName('cy@example.com — Preview');
  });

  it('renders nothing when presence is unavailable', () => {
    const { container } = render(<PresenceStrip presence={{ available: false, people: [] }} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing before the first answer or when nobody else is here', () => {
    const { container } = render(<PresenceStrip presence={undefined} />);
    const { container: empty } = render(
      <PresenceStrip presence={{ available: true, people: [] }} />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(empty).toBeEmptyDOMElement();
  });
});
