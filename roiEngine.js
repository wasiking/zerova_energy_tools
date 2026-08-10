/**
 * ZEROVA EV + BESS ROI 核心試算引擎 (純演算法，不依賴 DOM)
 */
const ROIEngine = {
    // 1. 台電費率常數表 (電動車專用電價)
    TARIFFS: {
        hv_ev: { name: '高壓專用電價', discount: 0.95 },
        lv_ev: { name: '低壓專用電價', discount: 1.00 }
    },
    RATES: {
        basicSummer: 47.20,      // 夏月經常契約基本費 (元/kW/月)
        basicNonSummer: 34.60,   // 非夏月經常契約基本費 (元/kW/月)
        avgPowerCost: 3.8,       // 假設平均台電購電成本
        evCapexRate: 6000,       // 充電樁硬體建置成本單價 (元/kW)
        bessCapexRate: 14000,    // 儲能設備建置單價 (元/kWh)
        emsCost: 300000          // EMS 軟硬體費用
    },

    /**
     * 計算第一區塊：單純充電站 (Baseline)
     */
    calcStandalone(inputs) {
        const { tariffType, gunCount, gunPower, dailyKwh, chargingPrice } = inputs;
        
        const totalPowerKw = gunCount * gunPower;
        const recContractKw = Math.round(totalPowerKw * 0.7); // 預設同時係數 0.7
        const evCapex = totalPowerKw * this.RATES.evCapexRate;

        // 台電折算費率
        const discount = this.TARIFFS[tariffType]?.discount || 0.95;
        const basicSummer = this.RATES.basicSummer * discount;
        const basicNonSummer = this.RATES.basicNonSummer * discount;

        // 充電賣電年毛利
        const annualChargingKwh = dailyKwh * 365;
        const annualChargingProfit = annualChargingKwh * (chargingPrice - this.RATES.avgPowerCost);

        // 年度基本電費支出
        const annualCapacityCost = recContractKw * (4 * basicSummer + 8 * basicNonSummer);
        const annualNetBenefit = annualChargingProfit - annualCapacityCost;

        // 回收年限
        const paybackYears = annualNetBenefit > 0 ? (evCapex / annualNetBenefit).toFixed(1) : "無法回本";

        return {
            totalPowerKw,
            recContractKw,
            evCapex,
            annualChargingProfit,
            annualCapacityCost,
            annualNetBenefit,
            paybackYears,
            basicSummer,
            basicNonSummer
        };
    },

    /**
     * 計算第二區塊：充儲一體化 (BESS + DLM)
     */
    calcIntegrated(inputs, standaloneResult) {
        const {
            enableBess, targetContractKw, bessKw, bessKwh,
            chkAvoidCapex, chkCapacitySavings, chkTouArbitrage, chkPenaltyAvoided
        } = inputs;

        if (!enableBess) {
            return {
                enableBess: false,
                totalCapex: standaloneResult.evCapex,
                annualNetBenefit: standaloneResult.annualNetBenefit,
                paybackYears: standaloneResult.paybackYears,
                breakdown: { chargingProfit: standaloneResult.annualChargingProfit, capacitySavings: 0, touArbitrage: 0, penaltyAvoided: 0 }
            };
        }

        const { totalPowerKw, recContractKw, evCapex, annualChargingProfit, basicSummer, basicNonSummer } = standaloneResult;

        // 擴容工程避險費 (約 150 萬元)
        const avoidedCapexVal = chkAvoidCapex ? 1500000 : 0;
        const bessCost = bessKwh * this.RATES.bessCapexRate;
        const totalCapex = Math.max(0, (evCapex + bessCost + this.RATES.emsCost) - avoidedCapexVal);

        // 1. 降低基本費節省
        const capacitySavedKw = Math.max(0, recContractKw - targetContractKw);
        const valCapacitySavings = chkCapacitySavings ? capacitySavedKw * (4 * basicSummer + 8 * basicNonSummer) : 0;

        // 2. 尖離峰時間電價套利 (DoD 90%, RTE 88%)
        const dailyBessDischarge = bessKwh * 0.9 * 0.88;
        const valTouArbitrage = chkTouArbitrage ? ((dailyBessDischarge * 7.0 * 120) + (dailyBessDischarge * 3.8 * 245)) : 0;

        // 3. 超約罰款規避價值
        const valPenaltyAvoided = chkPenaltyAvoided ? (totalPowerKw * 0.15) * (basicSummer * 2 * 4 + basicNonSummer * 2 * 8) : 0;

        // 充儲方案年度總效益
        const annualNetBenefit = annualChargingProfit + valCapacitySavings + valTouArbitrage + valPenaltyAvoided;
        const paybackYears = annualNetBenefit > 0 ? (totalCapex / annualNetBenefit).toFixed(1) : "無法回本";

        // 生成 10 年期現金流陣列
        const cashFlowA = [-evCapex];
        const cashFlowB = [-totalCapex];
        for (let i = 1; i <= 10; i++) {
            cashFlowA.push(-evCapex + (standaloneResult.annualNetBenefit * i));
            cashFlowB.push(-totalCapex + (annualNetBenefit * i));
        }

        return {
            enableBess: true,
            totalCapex,
            annualNetBenefit,
            paybackYears,
            breakdown: {
                chargingProfit: annualChargingProfit,
                capacitySavings: valCapacitySavings,
                touArbitrage: valTouArbitrage,
                penaltyAvoided: valPenaltyAvoided
            },
            cashFlowA,
            cashFlowB
        };
    },

    /**
     * 主進入點：接收全介面參數，傳回完整計算結果包
     */
    run(inputs) {
        const standalone = this.calcStandalone(inputs);
        const integrated = this.calcIntegrated(inputs, standalone);
        return { standalone, integrated };
    }
};