function definition(settings, id) {
  const model = settings.models?.find(model => model.id === id);
  if (!model) throw new Error('Invalid transcription model.');
  return model;
}
function validateModelDictionary(settings, id, terms) {
  const model = definition(settings, id);
  if (model.dictionaryHints && (terms.length > model.maxDictionaryTerms || terms.some(term => term.length > model.maxTermLength)))
    throw new Error(`${model.label} accepts up to ${model.maxDictionaryTerms} dictionary terms of ${model.maxTermLength} characters each.`);
}
module.exports = { definition, validateModelDictionary };
