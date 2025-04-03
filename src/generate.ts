import { buildPrompt, BuildPromptOptions, ExtensionSettingsManager, Message } from 'sillytavern-utils-lib';
import { ExtractedData } from 'sillytavern-utils-lib/types';
import { parseResponse } from './parsers.js';
import { Character } from 'sillytavern-utils-lib/types';
import { WIEntry } from 'sillytavern-utils-lib/types/world-info';
import { name1, name2 } from 'sillytavern-utils-lib/config';
import { ExtensionSettings, MessageRole } from './settings.js';

import * as Handlebars from 'handlebars';

export const globalContext = SillyTavern.getContext();

export type CharacterFieldName = 'name' | 'description' | 'personality' | 'scenario' | 'first_mes' | 'mes_example';

export const CHARACTER_FIELDS: CharacterFieldName[] = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
];

export const CHARACTER_LABELS: Record<CharacterFieldName, string> = {
  name: 'Name',
  description: 'Description',
  personality: 'Personality',
  scenario: 'Scenario',
  first_mes: 'First Message',
  mes_example: 'Example Dialogue',
};

export interface CharacterField {
  prompt: string;
  value: string;
  label: string;
}

export interface Session {
  selectedCharacterIndexes: string[];
  selectedWorldNames: string[];
  fields: Record<CharacterFieldName, CharacterField>;
  draftFields: Record<string, CharacterField>;
}

// @ts-ignore
const dumbSettings = new ExtensionSettingsManager<ExtensionSettings>('dumb', {}).getSettings();

export interface RunCharacterFieldGenerationParams {
  profileId: string;
  userPrompt: string;
  buildPromptOptions: BuildPromptOptions;
  session: Session;
  allCharacters: Character[];
  entriesGroupByWorldName: Record<string, WIEntry[]>;
  promptSettings: typeof dumbSettings.prompts;
  formatDescription: {
    content: string;
  };
  mainContextList: {
    promptName: string;
    role: MessageRole;
  }[];
  maxResponseToken: number;
  targetField: CharacterFieldName | string;
  outputFormat: 'xml' | 'json' | 'none';
}

export async function runCharacterFieldGeneration({
  profileId,
  userPrompt,
  buildPromptOptions,
  session,
  allCharacters,
  entriesGroupByWorldName,
  promptSettings,
  formatDescription,
  mainContextList,
  maxResponseToken,
  targetField,
  outputFormat,
}: RunCharacterFieldGenerationParams): Promise<string> {
  if (!profileId) {
    throw new Error('No connection profile selected.');
  }
  const profile = globalContext.extensionSettings.connectionManager?.profiles?.find((p: any) => p.id === profileId);
  if (!profile) {
    throw new Error(`Connection profile with ID "${profileId}" not found.`);
  }

  const processedUserPrompt = globalContext.substituteParams(userPrompt.trim());

  const selectedApi = profile.api ? globalContext.CONNECT_API_MAP[profile.api].selected : undefined;
  if (!selectedApi) {
    throw new Error(`Could not determine API for profile "${profile.name}".`);
  }

  const templateData: Record<string, any> = {};

  templateData['userInstructions'] = processedUserPrompt;
  templateData['fieldSpecificInstructions'] =
    session.draftFields[targetField]?.prompt ?? session.fields[targetField as CharacterFieldName]?.prompt;
  templateData['targetField'] = targetField;
  templateData['activeFormatInstructions'] = formatDescription.content;
  templateData['char'] = name1 ?? '{{char}}';
  templateData['user'] = name2 ?? '{{user}}';

  // Build base prompt (system, memory, messages, persona - if applicable)
  const chatMessages = await buildPrompt(selectedApi, buildPromptOptions);

  // Add Definitions of Selected Characters (if enabled and characters selected)
  {
    const charactersData: Array<Character> = [];
    session.selectedCharacterIndexes.forEach((charIndex) => {
      const charIndexNumber = parseInt(charIndex);
      const char = allCharacters[charIndexNumber];
      if (char) {
        charactersData.push(char);
      }
    });

    templateData['characters'] = charactersData;
  }

  // Add Definitions of Selected Lorebooks (World Info)
  {
    const lorebooksData: Record<string, WIEntry[]> = {};
    Object.entries(entriesGroupByWorldName)
      .filter(
        ([worldName, entries]) =>
          entries.length > 0 &&
          session.selectedWorldNames.includes(worldName) &&
          entries.some((entry) => !entry.disable),
      )
      .forEach(([worldName, entries]) => {
        lorebooksData[worldName] = entries.filter((entry) => !entry.disable);
      });

    templateData['lorebooks'] = lorebooksData;
  }

  // Add Current Field Values (if enabled)
  {
    const coreFields: Record<string, string> = Object.fromEntries(
      Object.entries(session.fields).map(([_fieldName, field]) => [field.label, field.value]),
    );
    const draftFields: Record<string, string> = Object.fromEntries(
      Object.entries(session.draftFields || {}).map(([_fieldName, field]) => [field.label, field.value]),
    );

    // Combine core and draft fields for the template context
    const allFields = {
      core: coreFields,
      draft: draftFields,
    };

    templateData['fields'] = allFields;
  }

  const messages: Message[] = [];
  {
    for (const mainContext of mainContextList) {
      // Chat history is exception, since it is not a template
      if (mainContext.promptName === 'chatHistory') {
        const chatHistory = chatMessages.map((message) => ({
          role: message.role,
          content: message.content,
        }));
        messages.push(...chatHistory);
        continue;
      }
      const prompt = promptSettings[mainContext.promptName];
      if (!prompt) {
        continue;
      }
      const message: Message = {
        role: mainContext.role,
        content: Handlebars.compile(prompt.content, { noEscape: true })(templateData),
      };
      message.content = message.content.replaceAll('{{user}}', '[[[crec_veryUniqueUserPlaceHolder]]]');
      message.content = message.content.replaceAll('{{char}}', '[[[crec_veryUniqueCharPlaceHolder]]]');
      message.content = globalContext.substituteParams(message.content);
      message.content = message.content.replaceAll('[[[crec_veryUniqueUserPlaceHolder]]]', '{{user}}');
      message.content = message.content.replaceAll('[[[crec_veryUniqueCharPlaceHolder]]]', '{{char}}');
      if (message.content) {
        messages.push(message);
      }
    }
  }

  // console.log("Sending messages:", JSON.stringify(messages, null, 2)); // For debugging

  const response = (await globalContext.ConnectionManagerRequestService.sendRequest(
    profileId,
    messages,
    maxResponseToken,
  )) as ExtractedData;

  // console.log("Received raw content:", response.content); // For debugging

  // Parse the response based on the expected format
  const parsedContent = parseResponse(response.content, outputFormat);

  return parsedContent;
}
