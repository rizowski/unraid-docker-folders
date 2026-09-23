import { Command, CommandRunner } from 'nest-commander';

import { FolderService } from '../folders/folder.service.js';

/**
 * `unraid-api docker-folders:status`.
 *
 * Answers the question the GraphQL endpoint cannot when the plugin fails to
 * load at all: is the package present, and can it read the database?
 */
@Command({
    name: 'docker-folders:status',
    description: 'Report whether Docker Folders is loaded and its database is readable',
})
export class StatusCommand extends CommandRunner {
    constructor(private readonly folderService: FolderService) {
        super();
    }

    async run(): Promise<void> {
        const info = this.folderService.getInfo();
        console.log(`version:  ${info.version}`);
        console.log(`database: ${info.databasePath}`);
        console.log(`readable: ${info.databaseReadable}`);
        if (info.databaseReadable) {
            const layout = this.folderService.getLayout();
            console.log(`folders:  ${layout.folders.length}`);
            console.log(`unfoldered order: ${layout.unfolderedOrder.length} entries`);
        }
    }
}
