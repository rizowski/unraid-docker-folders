import { BadRequestException, Injectable } from '@nestjs/common';

import { setAutostart, type AutostartWriteResult } from './autostart.js';

/**
 * Thin Nest wrapper around `setAutostart`. No constructor dependencies: the
 * pure function already defaults to the real Unraid paths on its own, the
 * same way `ContainerListService` calls `readAutostartMap()` with no
 * arguments in production and only tests pass a `TemplateSources` override.
 *
 * An injected `TemplateSources` provider was considered instead and rejected:
 * `index.ts` cannot be edited here to register one, and Nest has nothing to
 * resolve an untyped constructor parameter against, so this stays a
 * zero-dependency service and the tests exercise `setAutostart` directly.
 *
 * `setAutostart` itself stays framework-agnostic (no `@nestjs/common` import,
 * matching `unraid-templates.ts`) and throws a plain `Error` on an invalid
 * name; this is the one place that turns it into the same 400
 * `BadRequestException` `AdoptService` uses for its own "reached the service
 * with a bad argument" case, matching `containers.php`'s 400 for both.
 */
@Injectable()
export class AutostartService {
    setAutostart(name: string, enabled: boolean, delay: number | null | undefined): AutostartWriteResult {
        try {
            return setAutostart(name, enabled, delay);
        } catch (error) {
            throw new BadRequestException(error instanceof Error ? error.message : String(error));
        }
    }
}
