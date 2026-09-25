/**
 * 剧本创建扩展
 * PI Agent Extension - Script Creator
 * 
 * 支持：电影剧本、短剧、话剧、动画脚本
 */

export interface ScriptCreatorOptions {
  genre: string
  style: 'cinematic' | 'literary' | 'minimal'
  sceneCount: number
  characters: Character[]
  plot?: string
  tone: string
}

export interface Character {
  name: string
  role: string
  personality: string
}

export interface Scene {
  number: number
  location: string
  timeOfDay: string
  type: 'int' | 'ext'
  description: string
  dialogue: Dialogue[]
  action: string[]
}

export interface Dialogue {
  character: string
  line: string
  stageDirection?: string
}

export interface ScriptOutput {
  title: string
  genre: string
  logline: string
  scenes: Scene[]
  characters: Character[]
}

// Prompt templates for different genres
const GENRE_PROMPTS: Record<string, string> = {
  drama: '写一个情感丰富的戏剧场景，注重角色内心冲突和情感变化',
  comedy: '写一个幽默诙谐的场景，注重节奏和笑点设置',
  thriller: '写一个紧张刺激的悬疑场景，注重悬念和反转',
  'sci-fi': '写一个科幻场景，注重世界观设定和技术细节',
  romance: '写一个浪漫场景，注重情感细腻描写和氛围营造',
  horror: '写一个恐怖场景，注重氛围营造和心理暗示',
}

// Generate a script based on options
export function generateScript(options: ScriptCreatorOptions): ScriptOutput {
  const prompt = GENRE_PROMPTS[options.genre] || GENRE_PROMPTS.drama
  // This would call the AI model in production
  return {
    title: `未命名剧本`,
    genre: options.genre,
    logline: `${options.characters.length}个角色在${options.tone}的氛围中展开的故事`,
    scenes: [],
    characters: options.characters,
  }
}

// Get system prompt for the script creation agent
export function getSystemPrompt(genre: string, style: string): string {
  return `你是一位专业的剧本创作者。

风格：${style === 'cinematic' ? '电影化，注重画面感和镜头语言' : style === 'literary' ? '文学化，注重文字质感和意境' : '极简风格，注重节奏和留白'}

类型：${GENRE_PROMPTS[genre] || '通用'}

输出格式：
- 标准剧本格式
- 场景描述用 *斜体*
- 对话格式：**角色名**（表情/动作）：台词
- 场景标注：【内景/外景 - 地点 - 时间】

要求：
1. 对话自然真实，符合角色性格
2. 动作描写简洁有力
3. 节奏感强，注意张弛有度
4. 每个场景有明确的情绪弧线`
}
