import {
  type CreateWebhookEndpointRequest,
  type SubscribableEventType,
  subscribableEventTypeSchema,
} from '@repo/contracts';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { listProjects } from '@/features/workspace/api';

const EVENT_TYPES = subscribableEventTypeSchema.options;

interface EndpointFormProps {
  readonly orgId: string;
  readonly busy: boolean;
  /** A refusal to show above the button, already in words. */
  readonly error: string | null;
  readonly onSubmit: (body: CreateWebhookEndpointRequest) => void;
}

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** URL, events and project scope. No project selected means every project (FR-002). */
export function EndpointForm({
  busy,
  error,
  onSubmit,
  orgId,
}: EndpointFormProps): React.JSX.Element {
  const urlId = useId();
  const descriptionId = useId();
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [eventTypes, setEventTypes] = useState<SubscribableEventType[]>([]);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  const projects = useQuery({
    enabled: orgId !== '',
    queryFn: ({ signal }) => listProjects(orgId, signal),
    queryKey: ['projects', orgId],
  });

  const shown = localError ?? error;

  return (
    <form
      aria-label="Add endpoint"
      className="border-line mt-6 flex flex-col gap-4 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (eventTypes.length === 0) {
          setLocalError('Choose at least one event.');

          return;
        }
        setLocalError(null);
        onSubmit({ description: description.trim(), eventTypes, projectIds, url: url.trim() });
      }}
    >
      <h2 className="text-heading-sm font-semibold">Add endpoint</h2>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={urlId}>Endpoint URL</Label>
        <Input
          id={urlId}
          type="url"
          required
          maxLength={2048}
          placeholder="https://example.com/webhooks"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
          }}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={descriptionId}>Description</Label>
        <Input
          id={descriptionId}
          maxLength={200}
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
      </div>
      <fieldset>
        <legend className="text-label-sm font-medium">Events</legend>
        <div className="mt-2 grid grid-cols-2 gap-1">
          {EVENT_TYPES.map((type) => (
            <label key={type} className="text-body-sm flex items-center gap-2 font-mono">
              <input
                type="checkbox"
                checked={eventTypes.includes(type)}
                onChange={() => {
                  setEventTypes((current) => toggle(current, type));
                }}
              />
              {type}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="text-label-sm font-medium">Projects</legend>
        <p className="text-caption text-subdued">Leave all unticked to include every project.</p>
        <div className="mt-2 flex flex-col gap-1">
          {(projects.data?.projects ?? []).map((project) => (
            <label key={project.id} className="text-body-sm flex items-center gap-2">
              <input
                type="checkbox"
                checked={projectIds.includes(project.id)}
                onChange={() => {
                  setProjectIds((current) => toggle(current, project.id));
                }}
              />
              {project.name}
            </label>
          ))}
        </div>
      </fieldset>
      <div aria-live="assertive">
        {shown === null ? null : <Alert variant="danger">{shown}</Alert>}
      </div>
      <Button type="submit" className="self-start" disabled={busy}>
        Add endpoint
      </Button>
    </form>
  );
}
