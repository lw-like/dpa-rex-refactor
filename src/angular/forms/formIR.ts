export type ValidatorType =
    | 'required' | 'email' | 'min' | 'max' | 'minLength' | 'maxLength' | 'pattern' | 'custom';

export interface ValidatorIR {
    type: ValidatorType;
    args?: unknown[];       // numeric/string arguments (e.g. min value, maxLength, regex)
    originalCode?: string;  // verbatim source for 'custom' — left as a TODO comment
}

export interface FormNodeIR {
    type: 'group' | 'control' | 'array';
    controls?: Record<string, FormNodeIR>;  // only for 'group'
    itemSchema?: FormNodeIR;                // only for 'array' — shape of a single item
    initialItems?: FormNodeIR[];            // only for 'array' — pre-populated rows from the source
    initialValue?: unknown;                 // only for 'control' — '', null, 0, false, raw expr
    validators?: ValidatorIR[];
    /** Inferred TypeScript type: 'string' | 'number' | 'boolean' | 'any' */
    valueType?: string;
    /** Set when valueType === 'any' due to a complex or custom type in the original code */
    originalTypeSrc?: string;
}

export interface FormDetection {
    componentName: string;
    filePath: string;       // absolute fs path to the .ts file
    variableName: string;   // e.g. 'loginForm'
    declarationLine: number;
    ir: FormNodeIR;
    diagnostics: string[];
    htmlPath?: string;      // companion .html template, if found
}

/** Sent over the postMessage bridge after analysis completes */
export interface FormsAnalysisResult {
    detections: FormDetection[];
    componentName: string;
    tsPath: string;
    htmlPath?: string;
    error?: string;
}

/** Sent over the postMessage bridge after preview is built */
export interface FormsPreviewResult {
    variableName: string;
    tsPreview: string;
    htmlPreview: string;
    htmlPath?: string;
    diagnostics: string[];
}
