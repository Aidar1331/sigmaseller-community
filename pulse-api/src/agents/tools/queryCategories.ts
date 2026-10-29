import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { getAllSubjects, getSubjectCharacteristics } from '../../integrations/wb/content.js';

interface QueryCategoriesArgs {
  search: string;
  includeCharacteristics?: boolean;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function queryCategories(args: QueryCategoriesArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    const subjectsResult = await getAllSubjects(apiKey, {
      name: args.search,
      limit: 20,
    });

    const subjects = subjectsResult?.data ?? [];

    if (args.includeCharacteristics && subjects.length > 0) {
      const first = subjects[0];
      const charcs = await getSubjectCharacteristics(apiKey, first.subjectID);
      return JSON.stringify({
        subjects: subjects.map(s => ({
          subjectId: s.subjectID,
          name: s.subjectName,
          parentId: s.parentID,
          parentName: s.parentName,
        })),
        characteristicsForFirst: {
          subjectId: first.subjectID,
          subjectName: first.subjectName,
          characteristics: (charcs?.data ?? []).map((c: any) => ({
            id: c.charcID,
            name: c.name,
            required: c.required,
            type: c.charcType,
            unitName: c.unitName,
            maxCount: c.maxCount,
          })),
        },
      });
    }

    return JSON.stringify({
      subjects: subjects.map(s => ({
        subjectId: s.subjectID,
        name: s.subjectName,
        parentId: s.parentID,
        parentName: s.parentName,
      })),
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'Ошибка поиска категорий' });
  }
}
