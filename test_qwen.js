import { askQwen } from './src/qwen.js';

async function run() {
    console.log("Mocking a sample market...");
    const market = {
        question: "Will Bitcoin hit $70k in June?",
        outcomes: ["Yes", "No"],
        endDate: new Date().toISOString()
    };
    
    // Fake score and orderbook just to test the Qwen parsing logic
    const fakeScore = {
        primaryOutcomeLabel: market.outcomes[0],
        secondaryOutcomeLabel: market.outcomes[1],
        marketProbability: 45,
        underdogScore: 5
    };
    
    try {
        console.log("Calling Qwen Multi-Agent Debate...");
        const result = await askQwen({ 
            market: market, 
            score: fakeScore, 
            orderBook: { bids: [], asks: [] } 
        });
        console.log("=========== QWEN RESULT ===========");
        console.log("Verdict:", result.analysis.verdict);
        console.log("Confidence:", result.analysis.confidence);
        console.log("Kelly Sizing:", result.analysis.positionSizePct + "%");
        console.log("EV:", result.analysis.expectedValueCents);
        console.log("Bull Arguments:", result.analysis.bullishCase.length);
        console.log("Bear Arguments:", result.analysis.bearishCase.length);
        console.log("Summary:", result.analysis.summary);
        console.log("Final Reason:", result.analysis.finalReason);
        console.log("===================================");
    } catch (e) {
        console.error("Error calling Qwen:", e);
    }
}

run();
