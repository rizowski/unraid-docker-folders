import { BadRequestException, Injectable } from '@nestjs/common';

import { DatabaseService } from '../db/database.service.js';
import { nowSeconds } from '../util/time.js';
import type { DockerFoldersDismissal } from './container.model.js';

/**
 * The findings a user has accepted, ported from `SecurityAdvisor.php`.
 *
 * Only the store. The detection rules are not here and are not in the PHP
 * either: they live in the frontend, in `utils/securityFindings.ts`, computed
 * from fields the container list already carries. So there is nothing to port
 * on that side and nothing for the two backends to disagree about - both serve
 * the same list and the same dismissals, and the same code decides what is a
 * finding.
 *
 * Dismissals are keyed by container name rather than id, so accepting a
 * finding survives the container being recreated, which changes its id. Rows
 * are never pruned when a container is renamed or removed. That is deliberate
 * in the PHP: pruning would mean the container-list read mutating the database
 * even more than it already does.
 */

/**
 * The types a dismissal may name.
 *
 * Must stay byte-identical to `FINDING_TYPES` in the frontend's
 * `securityFindings.ts`, which is what actually produces them. A type accepted
 * here but never produced there is a row nothing will ever match; a type
 * produced there but rejected here is a dismiss button that fails.
 */
export const FINDING_TYPES = [
    'privileged',
    'docker-socket',
    'host-network',
    'added-capabilities',
    'broad-mount',
    'forced-root',
    'shared-mount-group',
] as const;

export type FindingType = (typeof FINDING_TYPES)[number];

@Injectable()
export class SecurityService {
    constructor(private readonly db: DatabaseService) {}

    listDismissals(): DockerFoldersDismissal[] {
        return this.db.read((db) =>
            db
                .prepare('SELECT container_name, finding_type FROM security_dismissals')
                .all()
                .map((row) => ({
                    containerName: String((row as { container_name: unknown }).container_name),
                    findingType: String((row as { finding_type: unknown }).finding_type),
                }))
        );
    }

    dismiss(containerName: string, findingType: string): boolean {
        this.assertValid(containerName, findingType);

        this.db.write((db) => {
            // INSERT OR REPLACE, matching PHP. Re-dismissing something already
            // dismissed rewrites created_at, which nothing reads.
            db.prepare(
                `INSERT OR REPLACE INTO security_dismissals (container_name, finding_type, created_at)
                 VALUES (?, ?, ?)`
            ).run(containerName, findingType, nowSeconds());
        });
        return true;
    }

    restore(containerName: string, findingType: string): boolean {
        this.assertValid(containerName, findingType);

        this.db.write((db) => {
            db.prepare(
                'DELETE FROM security_dismissals WHERE container_name = ? AND finding_type = ?'
            ).run(containerName, findingType);
        });
        return true;
    }

    private assertValid(containerName: string, findingType: string): void {
        if (containerName === '') {
            throw new BadRequestException('A dismissal needs a container name');
        }
        if (!(FINDING_TYPES as readonly string[]).includes(findingType)) {
            throw new BadRequestException(`Unknown finding type ${findingType}`);
        }
    }
}
