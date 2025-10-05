import TelegramBot, { TelegramExecutionContext } from '../../main/src/main.js';
import { marked } from 'marked';

export interface Environment {
	SECRET_TELEGRAM_API_TOKEN: string;
	SECRET_TELEGRAM_API_TOKEN2: string;
	SECRET_TELEGRAM_API_TOKEN3: string;
	AI: Ai;
	DB: D1Database;
	R2: R2Bucket;
}

type promiseFunc<T> = (resolve: (result: T) => void, reject: (e?: Error) => void) => Promise<T>;

/**
 * Wrap setTimeout in a Promise
 * @param func - function to call after setTimeout
 * @param time - delay in milliseconds (default: 1000)
 */
function wrapPromise<T>(func: promiseFunc<T>, time = 1000) {
	return new Promise((resolve, reject) => {
		setTimeout(() => {
			func(resolve, reject).catch((e: unknown) => {
				console.error('Error in wrapPromise:', e);
			});
		}, time);
	});
}

/**
 * Convert markdown to html that Telegram can parse
 * @param s - the string containing markdown
 * @returns HTML formatted string compatible with Telegram
 */
async function markdownToHtml(s: string): Promise<string> {
	marked.setOptions(marked.getDefaults());
	const parsed = await marked.parse(s) as string | { toString(): string };
	const parsedString = typeof parsed === 'string' ? parsed : parsed.toString();
	const tagsToRemove = ['p', 'ol', 'ul', 'li', 'h1', 'h2', 'h3'];
	const tagPattern = new RegExp(tagsToRemove.map((tag) => `<${tag}>|</${tag}>`).join('|'), 'g');
	return parsedString.replace(tagPattern, '');
}

// Constants for system prompts
const SYSTEM_PROMPTS = {
	TUX_ROBOT: 'You are a friendly assistant named TuxRobot. Use lots of emojis in your responses.',
	SEAN: 'You are a friendly person named Sean. Sometimes just acknowledge messages with okay. You are working on coding a cool telegram bot. You are 26 years old and from Toronto, Canada.',
};

// AI model constants
const AI_MODELS = {
	LLAMA: '@cf/meta/llama-3.2-11b-vision-instruct',
	CODER: '@hf/thebloke/deepseek-coder-6.7b-instruct-awq',
	FLUX: '@cf/black-forest-labs/flux-1-schnell',
	STABLE_DIFFUSION: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
};

export default {
	fetch: async (request: Request, env: Environment, ctx: ExecutionContext) => {
		const tuxrobot = new TelegramBot(env.SECRET_TELEGRAM_API_TOKEN);
		const duckduckbot = new TelegramBot(env.SECRET_TELEGRAM_API_TOKEN2);
		const translatepartybot = new TelegramBot(env.SECRET_TELEGRAM_API_TOKEN3);

		await Promise.all([
			tuxrobot
				.on(':document', async (bot: TelegramExecutionContext) => {
					const fileId: string = bot.update.message?.document?.file_id ?? '';
					const fileResponse = await bot.getFile(fileId);
					const id = crypto.randomUUID().slice(0, 5);
					await env.R2.put(id, await fileResponse.arrayBuffer());
					await bot.reply(`https://r2.seanbehan.ca/${id}`);
					return new Response('ok');
				})
				.on('epoch', async (bot: TelegramExecutionContext) => {
					if (bot.update_type === 'message') {
						await bot.reply(Math.floor(Date.now() / 1000).toString());
					}
					return new Response('ok');
				})
				.on('start', async (bot: TelegramExecutionContext) => {
					if (bot.update_type === 'message') {
						await bot.reply(
							'Send me a message to talk to llama3. Use /clear to wipe history. Use /photo to generate a photo. Use /code to generate code.',
						);
					}
					return new Response('ok');
				})
				.on('code', async (bot: TelegramExecutionContext) => {
					if (bot.update_type === 'message') {
						await bot.sendTyping();
						const prompt = bot.update.message?.text?.toString().split(' ').slice(1).join(' ') ?? '';
						const messages = [{ role: 'user', content: prompt }];

						try {
							// @ts-expect-error broken bindings
							const response = await env.AI.run(AI_MODELS.CODER, { messages });

							if ('response' in response) {
								await bot.reply(
									await markdownToHtml(
										typeof response.response === 'string' 
											? response.response 
											: JSON.stringify(response.response)
									), 
									'HTML'
								);
							}
						} catch (e) {
							console.error('Error in code handler:', e);
							await bot.reply(`Error: ${e as string}`);
						}
					}
					return new Response('ok');
				})
				.on('clear', async (bot: TelegramExecutionContext) => {
					if (bot.update_type === 'message') {
						await env.DB.prepare('DELETE FROM Messages WHERE userId=?').bind(bot.update.message?.from.id).run();
						await bot.reply('History cleared');
					}
					return new Response('ok');
				})
				.on(':message', async (bot: TelegramExecutionContext) => {
					switch (bot.update_type) {
						case 'message': {
							await bot.sendTyping();
							const prompt = bot.update.message?.text?.toString() ?? '';

							const { results } = await env.DB.prepare('SELECT * FROM Messages WHERE userId=?')
								.bind(bot.update.message?.from.id)
								.all();
							const messageHistory = results.map((col) => ({ role: 'system', content: col.content as string }));

							const messages = [
								{ role: 'system', content: SYSTEM_PROMPTS.TUX_ROBOT },
								...messageHistory,
								{ role: 'user', content: prompt },
							];

							try {
								console.log('Processing text message:', prompt);
								// @ts-expect-error broken bindings
								const response = await env.AI.run(AI_MODELS.LLAMA, { messages });

								if ('response' in response && response.response) {
									await bot.reply(
										await markdownToHtml(
											typeof response.response === 'string' 
												? response.response 
												: JSON.stringify(response.response)
										), 
										'HTML'
									);

									await env.DB.prepare('INSERT INTO Messages (id, userId, content) VALUES (?, ?, ?)')
										.bind(
											crypto.randomUUID(), 
											bot.update.message?.from.id, 
											`'[INST] ${prompt} [/INST] \n ${typeof response.response === 'string' ? response.response : JSON.stringify(response.response)}'`
										)
										.run();
								}
							} catch (e) {
								console.error('Error in message handler:', e);
								await bot.reply(`Error: ${e as string}`);
							}
							break;
						}

						case 'photo': {
							await bot.sendTyping();
							const photo = bot.update.message?.photo;
							const fileId: string = photo ? photo[photo.length - 1]?.file_id ?? '' : '';
							const prompt = bot.update.message?.caption ?? 'Please describe this image';

							console.log('Processing photo:', { fileId, prompt });

							const { results } = await env.DB.prepare('SELECT * FROM Messages WHERE userId=?')
								.bind(bot.update.message?.from.id)
								.all();
							const messageHistory = results.map((col) => ({ role: 'system', content: col.content as string }));

							const messages = [
								{ role: 'system', content: SYSTEM_PROMPTS.TUX_ROBOT },
								...messageHistory,
								{ role: 'user', content: prompt },
							];

							try {
								const fileResponse = await bot.getFile(fileId);
								const blob = await fileResponse.arrayBuffer();
								// @ts-expect-error broken bindings
								const response = await env.AI.run(AI_MODELS.LLAMA, { 
									messages, 
									image: [...new Uint8Array(blob)] 
								});

								if ('response' in response && response.response) {
									await bot.reply(
										await markdownToHtml(
											typeof response.response === 'string' 
												? response.response 
												: JSON.stringify(response.response)
										), 
										'HTML'
									);

									await env.DB.prepare('INSERT INTO Messages (id, userId, content) VALUES (?, ?, ?)')
										.bind(
											crypto.randomUUID(), 
											bot.update.message?.from.id, 
											`'[INST] ${prompt} [/INST] \n ${typeof response.response === 'string' ? response.response : JSON.stringify(response.response)}'`
										)
										.run();
								}
							} catch (e) {
								console.error('Error in photo handler:', e);
								await bot.reply(`Error processing image: ${e as string}`);
							}
							break;
						}

						case 'inline': {
							const query = bot.update.inline_query?.query.toString() ?? '';
							
							// Check if query ends with proper punctuation
							if (!query.endsWith('.') && !query.endsWith('?')) {
								await bot.replyInline(
									"Please complete your sentence",
									"End your sentence with a period (.) or question mark (?) to get an AI response",
									'HTML'
								);
								break;
							}

							const messages = [
								{ role: 'system', content: SYSTEM_PROMPTS.TUX_ROBOT },
								{ role: 'user', content: query },
							];

							try {
								// @ts-expect-error broken bindings
								const response = await env.AI.run(AI_MODELS.LLAMA, { messages, max_tokens: 100 });

								if ('response' in response) {
									await bot.replyInline(
										(typeof response.response === 'string' ? response.response : ''),
										await markdownToHtml(typeof response.response === 'string' ? response.response : ''),
										'HTML'
									);
								}
							} catch (e) {
								console.error('Error in inline handler:', e);
								await bot.reply(`Error: ${e as string}`);
							}
							break;
						}

						case 'business_message': {
							await bot.sendTyping();
							const photo = bot.update.business_message?.photo;
							const fileId: string = photo ? photo[photo.length - 1]?.file_id ?? '' : '';
							const prompt = bot.update.business_message?.text?.toString() ?? bot.update.business_message?.caption ?? '';

							if (bot.update.business_message?.from.id !== 69148517) {
								const { results } = await env.DB.prepare('SELECT * FROM Messages WHERE userId=?')
									.bind(bot.update.business_message?.from.id)
									.all();

								const messageHistory = results.map((col) => ({ role: 'system', content: col.content as string }));
								const messages = [{ role: 'system', content: SYSTEM_PROMPTS.SEAN }, ...messageHistory, { role: 'user', content: prompt }];

								try {
									let response;
									
									if (fileId) {
										const fileResponse = await bot.getFile(fileId);
										const blob = await fileResponse.arrayBuffer();
										// @ts-expect-error broken bindings
										response = await env.AI.run(AI_MODELS.LLAMA, { messages, image: [...new Uint8Array(blob)] });
									} else {
										// @ts-expect-error broken bindings
										response = await env.AI.run(AI_MODELS.LLAMA, { messages });
									}

									if ('response' in response && response.response) {
										await bot.reply(
											await markdownToHtml(
												typeof response.response === 'string' 
													? response.response 
													: JSON.stringify(response.response)
											), 
											'HTML'
										);

										await env.DB.prepare('INSERT INTO Messages (id, userId, content) VALUES (?, ?, ?)')
											.bind(
												crypto.randomUUID(), 
												bot.update.business_message?.from.id, 
												`'[INST] ${prompt} [/INST] \n ${typeof response.response === 'string' ? response.response : JSON.stringify(response.response)}'`
											)
											.run();
									}
								} catch (e) {
									console.error('Error in business message handler:', e);
									await bot.reply(`Error: ${e as string}`);
								}
							}
							break;
						}
					}
					return new Response('ok');
				})
				.on('photo', async (bot: TelegramExecutionContext) => {
					if (bot.update_type === 'message') {
						await bot.sendTyping();
						const prompt = bot.update.message?.text?.toString() ?? '';

						try {
							// @ts-expect-error broken bindings
							const photo = (await env.AI.run(AI_MODELS.FLUX, { prompt, steps: 8 })) as { image: string };

							const binaryString = atob(photo.image);
							// @ts-expect-error broken bindings
							const img = Uint8Array.from(binaryString, (m) => m.codePointAt(0));
							const photoFile = new File([await new Response(img).blob()], 'photo');
							const id = crypto.randomUUID();

							await env.R2.put(id, photoFile);
							console.log(`https://r2.seanbehan.ca/${id}`);
							await bot.replyPhoto(`https://r2.seanbehan.ca/${id}`);

							ctx.waitUntil(
								wrapPromise(async () => {
									await env.R2.delete(id);
								}, 500),
							);
						} catch (e) {
							console.error('Error in photo handler:', e);
							await bot.reply(`Error: ${e as string}`);
						}
					}
					return new Response('ok');
				})
				.handle(request.clone()),

			duckduckbot
				.on(':message', async (bot: TelegramExecutionContext) => {
					switch (bot.update_type) {
						case 'message': {
							await bot.reply('https://duckduckgo.com/?q=' + encodeURIComponent(bot.update.message?.text?.toString() ?? ''));
							break;
						}
						case 'inline': {
							await bot.reply('https://duckduckgo.com/?q=' + encodeURIComponent(bot.update.inline_query?.query ?? ''));
							break;
						}
					}
					return new Response('ok');
				})
				.handle(request.clone()),

			translatepartybot
				.on(':message', async (bot: TelegramExecutionContext) => {
					switch (bot.update_type) {
						case 'inline': {
							try {
								const query = encodeURIComponent(bot.update.inline_query?.query.toString() ?? '');
								const response = await fetch(
									`https://translate.googleapis.com/translate_a/single?sl=auto&tl=en&dt=t&dj=1&prev=input&ie=utf-8&oe=utf-8&client=gtx&q=${query}`,
								);

								const json = await response.json();
								const translatedText = (json as { sentences: [{ trans: string; orig: string; backend: number }] }).sentences[0].trans;

								await bot.reply(translatedText);
							} catch (e) {
								console.error('Error in translate handler:', e);
								await bot.reply(`Translation error: ${e as string}`);
							}
							break;
						}
						case 'message':
							await bot.reply('Use me in inline mode by typing @TranslatePartyBot and the text you want to translate.');
							break;
					}
					return new Response('ok');
				})
				.handle(request.clone()),
		]);

		return new Response('ok');
	},
};
