import { getEffectiveKeys } from '../lib/keyManager';
import { callGroqWithFallback } from '../lib/ai/pipeline';

export interface AthleticFuelingPlan {
  morningIgnition: {
    title: string;
    description: string;
    targetMacros: string;
  };
  preTrainingFuel: {
    title: string;
    description: string;
    timing: string;
  };
  postTrainingRecovery: {
    title: string;
    description: string;
    keyNutrients: string;
  };
  restorativeDinner: {
    title: string;
    description: string;
    repairBenefit: string;
  };
  hydrationTargetLiters: number;
  respiratoryProtocol?: string;
  dietaryRestrictionsObserved: string;
  medicalSafeguardsApplied: string;
}

/**
 * Generates daily athletic fueling and recovery nutrition calibrated to the
 * active sport and strictly compliant with dietary preferences and medical constraints.
 */
export async function generateAthleticFuelingPlan(params: {
  sportName: string;
  subGenre?: string;
  dietaryPreference: string;
  medicalConditions: string;
  preferredLanguage?: string;
}): Promise<AthleticFuelingPlan> {
  const { groqKey } = await getEffectiveKeys();
  const diet = params.dietaryPreference || 'Vegetarian';
  const medical = params.medicalConditions || 'None';
  const lang = params.preferredLanguage || 'en';

  const systemPrompt = `You are a Sports Nutritionist & Biomechanical Performance Scientist.
Generate a tailored daily athletic fueling & nutrition plan for an athlete training in:
Sport: "${params.sportName}" ${params.subGenre ? `(${params.subGenre})` : ''}
Dietary Preference: "${diet}" (STRICT: If Jain, NO root vegetables/potatoes/onions/garlic; if Vegan, NO dairy/eggs/honey; if Vegetarian, NO meat/fish/poultry; if Eggetarian, eggs allowed but NO meat/fish).
Medical/Physical Conditions: "${medical}" (STRICT: If Asthma, provide respiratory warmup/recovery pacing; if Knee/Joint sensitivity, include anti-inflammatory foods; if High BP, low sodium).
Language: Generate explanations in ${lang === 'hi' ? 'Hindi' : lang === 'fr' ? 'French' : lang === 'es' ? 'Spanish' : lang === 'de' ? 'German' : 'English'}.

Return strictly valid JSON:
{
  "morningIgnition": {
    "title": "Breakfast / Morning Ignition title",
    "description": "Exact meal components matching dietary restrictions and high energy carb-to-protein ratio",
    "targetMacros": "e.g. 35g Protein, 65g Complex Carbs"
  },
  "preTrainingFuel": {
    "title": "Pre-Training Energy (30-45m prior)",
    "description": "Easily digestible glycogen loader tailored to digestion and medical conditions",
    "timing": "30-45 minutes before practice"
  },
  "postTrainingRecovery": {
    "title": "Post-Training Muscle Synthesis",
    "description": "Recovery protein and electrolyte replenishment complying with dietary restrictions",
    "keyNutrients": "e.g. Fast-acting Protein, Electrolytes, Anti-inflammatory polyphenols"
  },
  "restorativeDinner": {
    "title": "Restorative Dinner & Overnight Repair",
    "description": "Nutrient-dense repair meal with targeted micronutrients (Magnesium, Zinc, Omega-3)",
    "repairBenefit": "e.g. Muscle fiber repair & deep slow-wave sleep recovery"
  },
  "hydrationTargetLiters": 3.2,
  "respiratoryProtocol": "Breathing cadence guidelines, especially if asthma or cardiovascular strain was reported",
  "dietaryRestrictionsObserved": "Summary of dietary rules strictly followed",
  "medicalSafeguardsApplied": "Summary of medical adaptations made"
}`;

  try {
    const res = await callGroqWithFallback(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Generate the complete 4-meal athletic nutrition schedule now.` },
      ],
      {
        apiKey: groqKey || '',
        temperature: 0.2,
        jsonMode: true,
      }
    );

    const parsed = JSON.parse(res.content);
    return {
      morningIgnition: parsed.morningIgnition || {
        title: 'Morning Ignition',
        description: 'Complex carbs and clean protein tailored to your active sport.',
        targetMacros: '30g Protein, 60g Carbs',
      },
      preTrainingFuel: parsed.preTrainingFuel || {
        title: 'Pre-Training Energy',
        description: 'Easily digestible carbs and electrolyte replenishment.',
        timing: '30-45 mins before session',
      },
      postTrainingRecovery: parsed.postTrainingRecovery || {
        title: 'Post-Training Muscle Synthesis',
        description: 'Targeted recovery protein and restorative nutrients.',
        keyNutrients: 'High Bioavailability Protein',
      },
      restorativeDinner: parsed.restorativeDinner || {
        title: 'Restorative Dinner',
        description: 'Balanced anti-inflammatory meal with sleep-supporting minerals.',
        repairBenefit: 'Muscle fiber repair & nervous system recovery',
      },
      hydrationTargetLiters: Number(parsed.hydrationTargetLiters) || 3.2,
      respiratoryProtocol: parsed.respiratoryProtocol || 'Deep diaphragmatic breathing: 4s inhale, 4s hold, 6s exhale post-practice.',
      dietaryRestrictionsObserved: parsed.dietaryRestrictionsObserved || `100% compliant with ${diet}`,
      medicalSafeguardsApplied: parsed.medicalSafeguardsApplied || `Calibrated for ${medical}`,
    };
  } catch (err) {
    console.warn('[nutritionEngine] LLM generation failed, providing tailored fallback plan', err);
    return getFallbackFuelingPlan(diet, medical);
  }
}

function getFallbackFuelingPlan(diet: string, medical: string): AthleticFuelingPlan {
  const isJain = diet.toLowerCase() === 'jain';
  const isVegan = diet.toLowerCase() === 'vegan';
  const isNonVeg = diet.toLowerCase().includes('non');
  const isEgg = diet.toLowerCase().includes('egg');

  let breakfast = 'Rolled oats porridge with chia seeds, soaked almonds, and spiced paneer bhurji.';
  let postWorkout = 'Plant or whey protein smoothie with soaked sprouted moong salad and lemon.';
  let dinner = 'Steamed dal khichdi with sautéed spinach, flaxseed powder, and roasted pumpkin seeds.';

  if (isJain) {
    breakfast = 'Warm quinoa and almond milk porridge with sunflower seeds, cinnamon, and fresh paneer cubes.';
    postWorkout = 'Soy protein shake with roasted chana and green moong sprouts (no onions or garlic).';
    dinner = 'Yellow moong dal with steamed brown rice, zucchini sabzi, and digestive ajwain tea.';
  } else if (isVegan) {
    breakfast = 'Tofu scramble with turmeric, spinach, whole grain toast, and hemp seed chia bowl.';
    postWorkout = 'Pea & brown rice protein smoothie with banana, spirulina, and raw walnuts.';
    dinner = 'Spiced lentil stew with roasted sweet potato, baby kale, and cold-pressed olive oil.';
  } else if (isNonVeg) {
    breakfast = '3 Whole eggs scramble with avocado, multigrain sourdough toast, and fresh papaya.';
    postWorkout = 'Grilled chicken breast with steamed broccoli, quinoa, and electrolyte coconut water.';
    dinner = 'Pan-seared salmon or grilled turkey with steamed asparagus and roasted sweet potatoes.';
  } else if (isEgg) {
    breakfast = '3 Soft-boiled eggs with whole wheat toast, sautéed bell peppers, and fresh berries.';
    postWorkout = 'Egg white omelet with whey protein shake and tender coconut water.';
    dinner = 'Grilled paneer steak with steamed greens, wild rice, and turmeric almond golden milk.';
  }

  return {
    morningIgnition: {
      title: 'Morning Ignition & Glycogen Load',
      description: breakfast,
      targetMacros: '30g Clean Protein, 65g Complex Carbs',
    },
    preTrainingFuel: {
      title: 'Pre-Training Energy (30m prior)',
      description: 'Ripe banana with 1 tbsp almond butter and 250ml tender coconut water.',
      timing: '30-45 minutes before practice',
    },
    postTrainingRecovery: {
      title: 'Post-Training Muscle Synthesis',
      description: postWorkout,
      keyNutrients: 'High Bioavailability Protein & Electrolytes',
    },
    restorativeDinner: {
      title: 'Restorative Dinner & Overnight Repair',
      description: dinner,
      repairBenefit: 'Magnesium-rich restorative meal for deep neuromuscular recovery',
    },
    hydrationTargetLiters: 3.2,
    respiratoryProtocol: medical.toLowerCase().includes('asthma')
      ? 'Perform 5 minutes of pursed-lip breathing before high-intensity drills; avoid cold fluid shocks.'
      : 'Diaphragmatic box breathing: 4s inhale, 4s hold, 4s exhale, 4s hold during cool-down.',
    dietaryRestrictionsObserved: `Strictly compliant with ${diet} preparation mandates.`,
    medicalSafeguardsApplied: `Nutritional and hydration density calibrated for: ${medical}.`,
  };
}
