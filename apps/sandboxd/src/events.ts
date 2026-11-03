import type { Admission } from './admission.ts';
import { classOf } from './classes.ts';
import type { DockerPort } from './docker.ts';
import { log } from './log.ts';

/** Log container deaths/OOMs and give freed capacity to the queue; returns the unsubscribe. */
export function watchEvents(docker: DockerPort, admission: Admission): () => void {
  return docker.events((e) => {
    const id = e.labels['sandboxd.id'];
    if (id === undefined) return;
    if (e.action === 'die' || e.action === 'oom') {
      log('info', `container ${e.action}`, { 'sandboxd.id': id, class: classOf(e.labels) });
    }
    if (e.action === 'die') void admission.tick();
  });
}
